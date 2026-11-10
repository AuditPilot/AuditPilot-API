				import worker, * as OTHER_EXPORTS from "D:\\AuditPilot2.0\\AuditPilot-API\\server\\worker.ts";
				import * as __MIDDLEWARE_0__ from "D:\\AuditPilot2.0\\AuditPilot-API\\node_modules\\wrangler\\templates\\middleware\\middleware-ensure-req-body-drained.ts";
import * as __MIDDLEWARE_1__ from "D:\\AuditPilot2.0\\AuditPilot-API\\node_modules\\wrangler\\templates\\middleware\\middleware-miniflare3-json-error.ts";

				export * from "D:\\AuditPilot2.0\\AuditPilot-API\\server\\worker.ts";
				const MIDDLEWARE_TEST_INJECT = "__INJECT_FOR_TESTING_WRANGLER_MIDDLEWARE__";
				export const __INTERNAL_WRANGLER_MIDDLEWARE__ = [
					
					__MIDDLEWARE_0__.default,__MIDDLEWARE_1__.default
				]
				export default worker;