import { describe, expect, it } from 'vitest';
import { NextRequest } from 'next/server';
import { middleware } from '@/middleware';

describe('middleware public routes', () => {
  it('allows the container health probe without a session', async () => {
    const response = await middleware(
      new NextRequest('http://localhost:3000/api/health'),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('x-middleware-next')).toBe('1');
  });
});
