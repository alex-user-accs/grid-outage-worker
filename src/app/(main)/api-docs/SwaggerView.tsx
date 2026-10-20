"use client";

import dynamic from "next/dynamic";
import "swagger-ui-react/swagger-ui.css";

// Swagger UI touches `window`, so it renders client-side only.
const SwaggerUI = dynamic(() => import("swagger-ui-react"), { ssr: false, loading: () => <p className="empty">Loading API reference…</p> });

export function SwaggerView({ spec }: { spec: object }) {
  return (
    <div className="swagger-host">
      {/* supportedSubmitMethods=[] removes "Try it out": docs can never spend quota or need a token in the browser. */}
      <SwaggerUI spec={spec} supportedSubmitMethods={[]} docExpansion="list" defaultModelsExpandDepth={0} deepLinking displayRequestDuration={false} />
    </div>
  );
}
