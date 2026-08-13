/** @type {import('next').NextConfig} */
const nextConfig = {
    output: 'standalone',
    turbopack: {},
    serverExternalPackages: ['bcrypt'],
    async headers() {
        return [
            {
                source: '/:path*',
                headers: [
                    { key: 'X-Content-Type-Options', value: 'nosniff' },
                    // Same-origin PDF previews use iframes. When a CSP is added,
                    // prefer frame-ancestors 'self' as the modern replacement.
                    { key: 'X-Frame-Options', value: 'SAMEORIGIN' },
                    { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
                    // Start with a short ramp; raise to 31536000 after one week
                    // of clean HTTPS operation before considering subdomains.
                    { key: 'Strict-Transport-Security', value: 'max-age=300' },
                    // Receipt capture uses input capture, not getUserMedia.
                    { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
                ],
            },
        ];
    },
    webpack: (config) => {
        return config;
    },
};

module.exports = nextConfig;
