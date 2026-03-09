/** @type {import('next').NextConfig} */
const nextConfig = {
    output: 'standalone',
    turbopack: {},
    serverExternalPackages: ['bcrypt'],
    webpack: (config) => {
        return config;
    },
};

module.exports = nextConfig;
