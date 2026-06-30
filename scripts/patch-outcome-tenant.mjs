import fs from "node:fs";

const f = "src/infrastructure/http/routes/outcome.ts";
let s = fs.readFileSync(f, "utf8");
s = s.replace(
  'import type { FastifyInstance } from "fastify";',
  'import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";',
);
s = s.replace(
  /resolveTenantId: \(request: \{[\s\S]*?\}\) => string;/,
  "resolveTenantId: (request: FastifyRequest, reply: FastifyReply) => string | null;",
);
s = s.replace(
  /const tenantId = deps\.resolveTenantId\(\s*request as \{[\s\S]*?\},\s*\);/g,
  `const tenantId = deps.resolveTenantId(request, reply);
    if (!tenantId) {
      return;
    }`,
);
fs.writeFileSync(f, s);
console.log("ok", (s.match(/if \(!tenantId\)/g) || []).length);
