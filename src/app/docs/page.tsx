"use client";

import dynamic from 'next/dynamic';
import 'swagger-ui-react/swagger-ui.css';

const SwaggerUI = dynamic(() => import('swagger-ui-react'), { ssr: false });

export default function ApiDocs() {
    return (
        <div className="bg-white min-h-screen pb-20">
            <SwaggerUI url="/api/docs" />
        </div>
    );
}
