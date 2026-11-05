import { Router, type Request, Response } from "express";
import { requireAuth } from "../../middleware/auth";
import { enqueue } from "../jobs/queue";
import { Report, type ReportDocument } from "../../models/Report";
import { findOwnAuditWithItems } from "../audits/service";

export const reportsRouter = Router();

reportsRouter.post(
  "/audits/:id/generate-insights",
  requireAuth,
  async (req: Request, res: Response) => {
    const auditId = String(req.params.id);
    const user = req.user!;

    // Ownership-checked BEFORE enqueueing: a foreign/untagged audit is a
    // plain 404 here (we never create jobs for other users' audits).
    const audit = await findOwnAuditWithItems(auditId, String(user._id));
    if (!audit) {
      return res.status(404).json({ message: "Audit not found" });
    }

    const job = await enqueue({
      type: "report-insights",
      userId: user._id,
      payload: { auditId },
    });
    return res.status(202).json({ jobId: String(job._id) });
  },
);

export async function listReportsForAudit(auditId: string): Promise<ReportDocument[]> {
  return Report.find({ auditId }).lean();
}

export async function createReport(data: Partial<ReportDocument>): Promise<ReportDocument> {
  return Report.create(data);
}
