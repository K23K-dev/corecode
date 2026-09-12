export function createApiHandler(options?: {
  environment?: Record<string, string | undefined>;
  executeCode?: (...args: any[]) => Promise<unknown>;
}): (request: Request) => Promise<Response>;

export function readVercelConfiguration(environment?: Record<string, string | undefined>): {
  appOrigin: string;
  connectionString: string;
};
