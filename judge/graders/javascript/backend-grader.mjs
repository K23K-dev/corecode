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

/**
 * A spec's `fixtures` and `check` are function expressions that may use these helpers
 * by name. `fixtures` supplies the modules a submission imports (auth.js, users.js,
 * axios); `check` exercises the submitted function for the case's variant.
 */
const helpers = { assert, express, request, response, deferred, deadline };
const specFunction = (source) =>
  new Function(...Object.keys(helpers), `return (${source});`)(...Object.values(helpers));

/**
 * Grades backend exercises against disposable requests, services, and database fixtures.
 * Checks receive { candidate, variant, res, next, calls, fixtures, database }; `database`
 * provides the products/users pool, also exposed to the submission as `pool`.
 */
export async function gradeBackendCase(spec, test, load) {
  const calls = [];
  const context = {
    variant: test.variant,
    fixtures: {},
    calls,
    res: response(),
    next: (error) => calls.push(error ?? 'next'),
  };
  if (spec.database) {
    context.database = await fixtureDatabase();
    context.fixtures.pool = context.database.pool;
  }
  if (spec.fixtures) specFunction(spec.fixtures)(context);
  // The compiled submission reads these fixtures when it is imported.
  globalThis.__fixtures = context.fixtures;
  try {
    const candidate = await load();
    assert.equal(typeof candidate, 'function', 'The requested function must exist.');
    if (!spec.check) throw new Error('No backend behavioral check exists.');
    await specFunction(spec.check)({ ...context, candidate });
    return { passed: true, actual: 'All behavioral checks passed.' };
  } finally {
    await context.database?.actualPool.end();
  }
}
