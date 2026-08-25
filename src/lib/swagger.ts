import swaggerJsdoc from 'swagger-jsdoc';
import { product } from '@/lib/product';

const options = {
    definition: {
        openapi: '3.0.0',
        info: {
            title: `${product.brand} API`,
            version: '1.0.0',
            description: product.description,
        },
        servers: [
            {
                url: 'http://localhost:3000',
                description: 'Development server',
            },
        ],
        components: {
            securitySchemes: {
                // The `gcw_` personal access tokens described in
                // docs/api-tokens.md. Declared here rather than per-route so
                // the `security: [{ bearerAuth: [] }]` annotations on the
                // integration endpoints resolve to a real definition instead
                // of a dangling reference.
                bearerAuth: {
                    type: 'http',
                    scheme: 'bearer',
                    description: 'Personal access token from Settings → API Tokens (gcw_…).',
                },
            },
        },
    },
    apis: ['./src/app/api/**/*.ts', './src/lib/types.ts'], // Path to the API docs
};

export const getApiDocs = () => {
    const spec = swaggerJsdoc(options);
    return spec;
};
