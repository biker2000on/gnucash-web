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
    },
    apis: ['./src/app/api/**/*.ts', './src/lib/types.ts'], // Path to the API docs
};

export const getApiDocs = () => {
    const spec = swaggerJsdoc(options);
    return spec;
};
