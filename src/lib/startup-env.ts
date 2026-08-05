export class StartupEnvironmentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StartupEnvironmentError';
  }
}

/** Validate the variables required by both the web and worker containers. */
export function validateStartupEnvironment(
  env: {
    DATABASE_URL?: string;
    SESSION_SECRET?: string;
    NEXTAUTH_SECRET?: string;
  } = process.env as {
    DATABASE_URL?: string;
    SESSION_SECRET?: string;
    NEXTAUTH_SECRET?: string;
  },
): void {
  if (!env.DATABASE_URL?.trim()) {
    throw new StartupEnvironmentError('DATABASE_URL is required');
  }

  const sessionSecret = env.SESSION_SECRET || env.NEXTAUTH_SECRET;
  if (!sessionSecret) {
    throw new StartupEnvironmentError('SESSION_SECRET or NEXTAUTH_SECRET is required');
  }
  if (sessionSecret.length < 32) {
    throw new StartupEnvironmentError(
      'SESSION_SECRET or NEXTAUTH_SECRET must be at least 32 characters',
    );
  }
}
