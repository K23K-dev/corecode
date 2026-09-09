import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import { newDb } from 'pg-mem';

function response() {
  return {
    statusCode: 200,
    headersSent: false,
    body: undefined,
    ended: false,
    writes: 0,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(value) {
      this.body = value;
      this.writes++;
      return this;
    },
    end() {
      this.ended = true;
      this.writes++;
      return this;
    },
  };
}
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};
const deadline = (promise) =>
  Promise.race([
    promise,
    new Promise((_, reject) => {
      const timer = setTimeout(() => reject(new Error('Operation did not complete.')), 1500);
      timer.unref();
    }),
  ]);

async function fixtureDatabase() {
  const db = newDb();
  db.public.none(
    'CREATE TABLE products (id serial PRIMARY KEY, name text NOT NULL, price float NOT NULL, created_at timestamp NOT NULL DEFAULT now()); CREATE TABLE users (id serial PRIMARY KEY, email text UNIQUE NOT NULL, password_hash text NOT NULL);',
  );
  const { Pool } = db.adapters.createPg();
  const actualPool = new Pool();
  const products = [];
  for (let id = 1; id <= 45; id++) {
    const product = {
      id,
      name: id === 7 ? 'Tea' : 'Product ' + String(46 - id).padStart(2, '0'),
      price: id === 7 ? 4.5 : id / 2,
    };
    products.push(product);
    await actualPool.query('INSERT INTO products (name, price, created_at) VALUES ($1,$2,$3)', [
      product.name,
      product.price,
      new Date(Date.UTC(2026, 0, id)),
    ]);
  }
  const queries = [];
  const pool = {
    query: async (sql, params) => {
      queries.push({ sql, params });
      return actualPool.query(sql, params);
    },
  };
  return { pool, actualPool, products, queries };
}

export async function backendCheck(spec, test, load) {
  const { variant } = test,
    id = spec.id;
  const fixtures = {},
    calls = [],
    res = response(),
    next = (error) => calls.push(error ?? 'next');
  let database;
  if (/^backend-express-00[1-5]-/.test(id) || id === 'backend-auth-000-insert-user') {
    database = await fixtureDatabase();
    fixtures.pool = database.pool;
  }
  if (id === 'backend-pg-002-transaction')
    fixtures.withDatabaseClient = async (pool, operation) => {
      const client = await pool.connect();
      try {
        return await operation(client);
      } finally {
        client.release();
      }
    };
  if (id === 'backend-auth-001-register') {
    fixtures.hashPassword = async (password) => {
      calls.push(['hash', password]);
      return 'opaque-password-hash';
    };
    fixtures.insertUser = async (email, hash) => {
      calls.push(['insert', email, hash]);
      if (variant) {
        const error = new Error('database failure');
        error.code = variant === 1 ? '23505' : '08006';
        fixtures.error = error;
        throw error;
      }
      return { id: 7, email };
    };
  }
  if (id === 'backend-auth-002-login') {
    fixtures.findUserByEmail = async (email) => {
      calls.push(['find', email]);
      return variant === 1
        ? null
        : {
            id: 7,
            email: 'ada@example.com',
            role: 'user',
            passwordHash: 'stored-hash',
            privateNote: 'secret',
          };
    };
    fixtures.comparePassword = async (password, hash) => {
      calls.push(['compare', password, hash]);
      return variant !== 2;
    };
    fixtures.signToken = (payload) => {
      calls.push(['sign', payload]);
      return 'signed-token';
    };
  }
  if (id === 'backend-auth-003-require-auth')
    fixtures.verifyToken = (token) => {
      calls.push(['verify', token]);
      if (token !== 'valid-token') throw new Error('bad token');
      return { sub: '7', role: 'user' };
    };
  if (id === 'backend-axios-001-dashboard') {
    fixtures.requests = [];
    fixtures.axios = {
      get: (path) => {
        const pending = deferred();
        fixtures.requests.push({ path, ...pending });
        return pending.promise;
      },
    };
  }
  globalThis.__fixtures = fixtures;
  const candidate = await load();
  assert.equal(typeof candidate, 'function', 'The requested function must exist.');
  try {
    if (id === 'backend-express-001-get-product') {
      const target = [7, 999, 3][variant];
      await candidate({ params: { id: String(target) } }, res);
      assert.equal(res.statusCode, target === 999 ? 404 : 200);
      assert.deepEqual(
        res.body,
        target === 999
          ? { error: 'Product not found' }
          : database.products.find((product) => product.id === target),
      );
      assert(
        database.queries.some(
          (query) => Array.isArray(query.params) && query.params.includes(target),
        ),
        'Pass the id as a SQL parameter.',
      );
    } else if (id === 'backend-express-002-list-products') {
      const query = [
        { sort: 'price', page: '2' },
        {},
        { sort: 'constructor', page: '-4' },
        { sort: 'name', page: '1' },
      ][variant];
      await candidate({ query }, res);
      const ordered = [...database.products].sort(
        variant === 0
          ? (a, b) => a.price - b.price
          : variant === 3
            ? (a, b) => a.name.localeCompare(b.name)
            : (a, b) => b.id - a.id,
      );
      assert.deepEqual(res.body, {
        items: ordered.slice(variant === 0 ? 20 : 0, variant === 0 ? 40 : 20),
        page: variant === 0 ? 2 : 1,
        limit: 20,
      });
      if (variant === 2) {
        const second = response();
        await candidate({ query: { sort: ['price'], page: 'garbage' } }, second);
        assert.deepEqual(
          second.body,
          res.body,
          'Non-string sort and invalid page must use safe defaults.',
        );
      }
    } else if (id === 'backend-express-003-create-product') {
      if (variant === 1) {
        for (const body of [
          { name: '  ', price: 1 },
          { name: 'Pen', price: -1 },
          { name: 'Pen', price: '2' },
          null,
        ]) {
          const result = response();
          await candidate({ body }, result);
          assert.equal(result.statusCode, 400);
          assert.deepEqual(result.body, { error: 'Invalid product' });
        }
        assert.equal(database.queries.length, 0, 'Do not write invalid products to the database.');
      } else {
        const name = variant === 0 ? 'Pen' : "Ada's Pen",
          price = variant === 0 ? 2 : 0;
        await candidate({ body: { name: variant === 0 ? ' Pen ' : name, price } }, res);
        assert.equal(res.statusCode, 201);
        assert.deepEqual(res.body, { id: 46, name, price });
        assert.deepEqual(
          (await database.actualPool.query('SELECT id,name,price FROM products WHERE id=46')).rows,
          [res.body],
        );
        assert(
          database.queries.some(
            (query) => query.params?.includes(name) && query.params.includes(price),
          ),
          'Supply product fields as query parameters.',
        );
      }
    } else if (id === 'backend-express-004-patch-product') {
      const target = [7, 999, 3][variant],
        name = variant === 2 ? "Ada's Tea" : 'Tea';
      await candidate({ params: { id: String(target) }, body: { name, price: 5 } }, res);
      assert.equal(res.statusCode, variant === 1 ? 404 : 200);
      assert.deepEqual(
        res.body,
        variant === 1 ? { error: 'Product not found' } : { id: target, name, price: 5 },
      );
      if (variant !== 1)
        assert.deepEqual(
          (
            await database.actualPool.query('SELECT id,name,price FROM products WHERE id=$1', [
              target,
            ])
          ).rows[0],
          res.body,
        );
      assert.equal(
        (await database.actualPool.query('SELECT count(*) AS count FROM products')).rows[0].count,
        45,
      );
      assert(
        database.queries.some(
          (query) => query.params?.includes(target) && query.params.includes(name),
        ),
        'Supply request values as parameters.',
      );
    } else if (id === 'backend-express-005-delete-product') {
      const target = [7, 999, 3][variant];
      await candidate({ params: { id: String(target) } }, res);
      assert.equal(res.statusCode, variant === 1 ? 404 : 204);
      if (variant === 1) assert.deepEqual(res.body, { error: 'Product not found' });
      else {
        assert(res.ended && res.body === undefined, 'Send an empty 204 response.');
        assert.equal(
          (await database.actualPool.query('SELECT id FROM products WHERE id=$1', [target])).rows
            .length,
          0,
        );
      }
      if (variant === 2) {
        const second = response();
        await candidate({ params: { id: '3' } }, second);
        assert.equal(second.statusCode, 404);
        assert.equal(
          (await database.actualPool.query('SELECT count(*) AS count FROM products')).rows[0].count,
          44,
        );
      }
    } else if (id === 'backend-express-006-error-handler') {
      const error = {
        status: variant === 0 ? 400 : variant === 1 ? 503 : 200,
        message: variant === 0 ? 'Bad request' : 'secret database password',
      };
      if (variant === 3) res.headersSent = true;
      await candidate(error, {}, res, next);
      if (variant === 3) {
        assert.equal(calls[0], error);
        assert.equal(res.writes, 0);
      } else {
        assert.equal(res.statusCode, variant === 0 ? 400 : variant === 1 ? 503 : 500);
        assert.deepEqual(res.body, {
          error: variant === 0 ? 'Bad request' : 'Internal server error',
        });
      }
      if (variant === 2) {
        const other = response();
        await candidate({ status: '404' }, {}, other, next);
        assert.equal(other.statusCode, 500);
        assert.deepEqual(other.body, { error: 'Internal server error' });
      }
    } else if (id === 'backend-pg-001-with-client') {
      const error = new Error('operation failure'),
        answer = { rows: [{ value: 1 }] },
        client = { release: () => calls.push('release'), query: async () => answer };
      const pool = {
        connect: async () => {
          calls.push('connect');
          if (variant === 2) throw error;
          return client;
        },
      };
      const operation = async (received) => {
        assert.equal(received, client);
        calls.push('operation');
        if (variant === 1) throw error;
        return received.query('SELECT 1');
      };
      if (variant === 0) {
        assert.equal(await candidate(pool, operation), answer);
        assert.deepEqual(calls, ['connect', 'operation', 'release']);
      } else {
        await assert.rejects(candidate(pool, operation), (thrown) => thrown === error);
        assert.deepEqual(calls, variant === 1 ? ['connect', 'operation', 'release'] : ['connect']);
      }
    } else if (id === 'backend-auth-001-register') {
      const run = () =>
        candidate({ body: { email: ' ADA@EXAMPLE.COM ', password: 'secret123' } }, res);
      if (variant === 2) await assert.rejects(run(), (error) => error === fixtures.error);
      else {
        await run();
        assert.equal(res.statusCode, variant === 1 ? 409 : 201);
        assert.deepEqual(
          res.body,
          variant === 1
            ? { error: 'Email already registered' }
            : { id: 7, email: 'ada@example.com' },
        );
      }
      assert.deepEqual(calls, [
        ['hash', 'secret123'],
        ['insert', 'ada@example.com', 'opaque-password-hash'],
      ]);
    } else if (id === 'backend-auth-002-login') {
      await candidate({ body: { email: ' ADA@EXAMPLE.COM ', password: 'secret123' } }, res);
      assert.deepEqual(calls[0], ['find', 'ada@example.com']);
      if (variant === 0) {
        assert.deepEqual(res.body, {
          token: 'signed-token',
          user: { id: 7, email: 'ada@example.com', role: 'user' },
        });
        assert.deepEqual(calls.slice(1), [
          ['compare', 'secret123', 'stored-hash'],
          ['sign', { sub: '7', role: 'user' }],
        ]);
      } else {
        assert.equal(res.statusCode, 401);
        assert.deepEqual(res.body, { error: 'Invalid email or password' });
        assert(
          !calls.some((call) => call[0] === 'sign'),
          'Never sign a token for invalid credentials.',
        );
      }
    } else if (id === 'backend-auth-003-require-auth') {
      const header = [
        'Bearer valid-token',
        undefined,
        'Bearer invalid-token',
        'bearer valid-token',
      ][variant];
      const req = {
        headers: { authorization: header },
        get: (name) => (name.toLowerCase() === 'authorization' ? header : undefined),
      };
      await candidate(req, res, next);
      if (variant === 0 || variant === 3) {
        assert.deepEqual(req.user, { sub: '7', role: 'user' });
        assert.equal(calls.at(-1), 'next');
        assert.deepEqual(calls[0], ['verify', 'valid-token']);
      } else {
        assert.equal(res.statusCode, 401);
        assert.deepEqual(res.body, { error: 'Unauthorized' });
        assert(!calls.includes('next'));
        assert.equal(req.user, undefined);
      }
      if (variant === 1) {
        const second = response();
        await candidate(
          { get: () => 'Basic valid-token', headers: { authorization: 'Basic valid-token' } },
          second,
          next,
        );
        assert.equal(second.statusCode, 401);
        assert(!calls.includes('next'));
      }
    } else if (id === 'backend-auth-004-owner-or-admin') {
      await candidate(
        {
          user: { sub: '8', role: variant === 1 ? 'admin' : 'user' },
          product: { ownerId: variant === 0 ? 8 : 9 },
        },
        res,
        next,
      );
      if (variant === 2) {
        assert.equal(res.statusCode, 403);
        assert.deepEqual(res.body, { error: 'Forbidden' });
        assert.equal(calls.length, 0);
      } else assert.deepEqual(calls, ['next']);
    } else if (id === 'backend-axios-001-dashboard') {
      const userId = variant === 1 ? 12 : 7,
        result = candidate(userId),
        observed = Promise.resolve(result).then(
          (value) => ({ value }),
          (error) => ({ error }),
        );
      await Promise.resolve();
      assert.deepEqual(
        fixtures.requests.map((request) => request.path),
        [`/users/${userId}`, `/users/${userId}/notifications`],
        'Both requests must start before either completes.',
      );
      const error = new Error('upstream failure');
      if (variant === 2) fixtures.requests[0].reject(error);
      else fixtures.requests[0].resolve({ data: { id: userId, name: 'Ada' } });
      fixtures.requests[1].resolve({ data: [{ id: 2, unread: true }] });
      const completed = await deadline(observed);
      if (variant === 2) assert.equal(completed.error, error);
      else
        assert.deepEqual(completed.value, {
          profile: { id: userId, name: 'Ada' },
          notifications: [{ id: 2, unread: true }],
        });
    } else if (id === 'backend-express-007-rate-limit') {
      const original = Date.now;
      let time = 120_000;
      Date.now = () => time;
      const hit = async (ip) => {
        const result = response(),
          allowed = [];
        await candidate({ ip }, result, () => allowed.push(true));
        return allowed.length ? 'next' : result.statusCode;
      };
      try {
        if (variant === 1) {
          for (let index = 0; index < 3; index++) {
            assert.equal(await hit('10.0.0.1'), 'next');
            assert.equal(await hit('10.0.0.2'), 'next');
          }
        } else {
          assert.deepEqual(
            [
              await hit('10.0.0.1'),
              await hit('10.0.0.1'),
              await hit('10.0.0.1'),
              await hit('10.0.0.1'),
            ],
            ['next', 'next', 'next', 429],
          );
          if (variant === 2) {
            time = 180_000;
            assert.equal(await hit('10.0.0.1'), 'next');
          }
        }
      } finally {
        Date.now = original;
      }
    } else if (id === 'backend-cache-001-product') {
      const product = { id: 7, name: 'Tea', price: 4.5 };
      const redis = {
        get: async (key) => {
          calls.push(['get', key]);
          return variant === 0 ? JSON.stringify(product) : null;
        },
        set: async (...args) => calls.push(['set', ...args]),
      };
      const loader = async (id) => {
        calls.push(['load', id]);
        return variant === 2 ? null : product;
      };
      assert.deepEqual(await candidate(redis, loader, 7), variant === 2 ? null : product);
      assert.deepEqual(
        calls,
        variant === 0
          ? [['get', 'product:7']]
          : variant === 2
            ? [
                ['get', 'product:7'],
                ['load', 7],
              ]
            : [
                ['get', 'product:7'],
                ['load', 7],
                ['set', 'product:7', JSON.stringify(product), { EX: 60 }],
              ],
      );
    } else if (id === 'backend-pg-002-transaction') {
      const error = new Error('transaction failure');
      const client = {
        query: async (sql) => {
          calls.push(sql.trim().toUpperCase());
          if (variant === 2 && sql.trim().toUpperCase() === 'COMMIT') throw error;
        },
        release: () => calls.push('release'),
      };
      const pool = {
        connect: async () => {
          calls.push('connect');
          return client;
        },
      };
      const operation = async (received) => {
        assert.equal(received, client);
        calls.push('operation');
        if (variant === 1) throw error;
      };
      if (variant === 0) {
        await candidate(pool, operation);
        assert.deepEqual(calls, ['connect', 'BEGIN', 'operation', 'COMMIT', 'release']);
      } else {
        await assert.rejects(candidate(pool, operation), (thrown) => thrown === error);
        assert.deepEqual(
          calls,
          variant === 1
            ? ['connect', 'BEGIN', 'operation', 'ROLLBACK', 'release']
            : ['connect', 'BEGIN', 'operation', 'COMMIT', 'ROLLBACK', 'release'],
        );
      }
    } else if (id === 'backend-express-000-app-wiring') {
      const router = express.Router();
      router.post('/', (req, res) => res.json({ received: req.body }));
      router.get('/', (_req, res) => res.json({ mounted: true }));
      router.get('/failure', (_req, _res, next) => next(new Error('route error')));
      const app = candidate(router, (error, _req, res, _next) =>
        res.status(418).json({ error: error.message }),
      );
      assert.equal(typeof app, 'function', 'Return the Express app.');
      if (variant === 0) {
        const result = await request(app)
          .post('/products')
          .send({ name: 'Pen', price: 2 })
          .timeout(1000);
        assert.equal(result.status, 200);
        assert.deepEqual(result.body, { received: { name: 'Pen', price: 2 } });
      } else if (variant === 1) {
        const result = await request(app).get('/products/failure').timeout(1000);
        assert.equal(result.status, 418);
        assert.deepEqual(result.body, { error: 'route error' });
      } else {
        assert.equal((await request(app).get('/products').timeout(1000)).status, 200);
        assert.equal((await request(app).get('/').timeout(1000)).status, 404);
      }
    } else if (id === 'backend-auth-000-insert-user') {
      const email = variant === 1 ? "ada.o'neil@example.test" : 'ada@example.com';
      const user = await candidate(email, 'stored-hash');
      assert.deepEqual(user, { id: 1, email });
      assert.deepEqual(
        (await database.actualPool.query('SELECT email,password_hash FROM users')).rows,
        [{ email, password_hash: 'stored-hash' }],
      );
      assert(
        database.queries.some(
          (query) => query.params?.includes(email) && query.params.includes('stored-hash'),
        ),
        'Pass email and password hash as SQL parameters.',
      );
      if (variant === 2)
        await assert.rejects(candidate(email, 'other-hash'), (error) => error.code === '23505');
    } else throw new Error('No backend behavioral check exists.');
    return { passed: true, actual: 'All behavioral checks passed.' };
  } finally {
    await database?.actualPool.end();
  }
}
