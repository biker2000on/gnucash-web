'use client';

import dynamic from 'next/dynamic';
import 'swagger-ui-react/swagger-ui.css';

const SwaggerUI = dynamic(() => import('swagger-ui-react'), { ssr: false });

export default function ApiDocs() {
  return (
    <div className="-m-5 min-h-screen bg-white sm:-m-8 lg:-m-12 lg:-my-14">
      <SwaggerUI url="/api/docs" />
    </div>
  );
}
