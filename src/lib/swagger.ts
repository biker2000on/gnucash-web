import swaggerJsdoc from 'swagger-jsdoc';

const options = {
    definition: {
        openapi: '3.0.0',
        info: {
            title: 'GnuCash Web API',
            version: '1.0.0',
            description: 'API for GnuCash Web PWA',
        },
        servers: [
            {
                url: 'http://localhost:3000',
                description: 'Development server',
            },
        ],
    },
    apis: ['./src/app/api/**/*.ts', './src/lib/types.ts'], // Path to the API docs
};

export const getApiDocs = () => {
    const spec = swaggerJsdoc(options);
    return spec;
};
