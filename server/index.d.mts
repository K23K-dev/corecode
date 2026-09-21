export function createApiHandler(options?: {
  environment?: Record<string, string | undefined>;
  keepAlive?: (task: Promise<unknown>) => void;
}): (request: Request) => Promise<Response>;

export function readVercelConfiguration(environment?: Record<string, string | undefined>): {
  appOrigin: string;
  connectionString: string;
};
