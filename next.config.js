const withPWA = require('next-pwa')({
    dest: 'public',
    register: true,
    skipWaiting: true,
    disable: process.env.NODE_ENV === 'development'
});

/** @type {import('next').NextConfig} */
const nextConfig = {
    // Your other Next.js config options here
    output: 'standalone',
    turbopack: {},
    serverExternalPackages: ['bcrypt'],
    webpack: (config) => {
        return config;
    },
};

module.exports = withPWA(nextConfig);
