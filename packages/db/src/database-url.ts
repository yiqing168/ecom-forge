export const LOCAL_DATABASE_URL =
  'postgresql://ecom_forge:ecom_forge_dev@localhost:5432/ecom_forge';

export function resolveDatabaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const configuredUrl = env.DATABASE_URL?.trim();
  if (configuredUrl) {
    return configuredUrl;
  }

  if (env.NODE_ENV === 'production') {
    throw new Error('DATABASE_URL is required when NODE_ENV=production');
  }

  return LOCAL_DATABASE_URL;
}
