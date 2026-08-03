'use client';

import dynamic from 'next/dynamic';
import 'swagger-ui-react/swagger-ui.css';

const SwaggerUI = dynamic(() => import('swagger-ui-react'), { ssr: false });

export default function ApiDocs() {
  // swagger-ui.css is light-only, so this container stays literally white
  // rather than following the app's surface token.
  return (
    <div className="-m-5 min-h-screen bg-white sm:-m-8 lg:-m-12 lg:-my-14">
      <SwaggerUI url="/api/docs" />
    </div>
  );
}
