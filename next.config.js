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
                    { key: 'X-Frame-Options', value: 'DENY' },
                    { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
                    { key: 'Strict-Transport-Security', value: 'max-age=31536000; includeSubDomains' },
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
