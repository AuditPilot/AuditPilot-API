import mongoose, { type Types } from "mongoose";
import { Report, type ReportDocument } from "../../models/Report";
import { runTask, untrustedDataBlock } from "../../integrations/ai/gateway";
import { findOwnAuditWithItems } from "../audits/service";
import { AppError } from "../../middleware/errorHandler";

/**
 * Generates (and persists) the AI insights report for an audit.
 * Extracted from the HTTP route so the report-insights job worker reuses it.
 * Ownership is enforced here: foreign/untagged audits fail with notFound.
 */
export async function generateInsightsReport(input: {
  auditId: string;
  userId: string;
}): Promise<ReportDocument> {
  const audit = await findOwnAuditWithItems(input.auditId, input.userId);
  if (!audit) {
    throw AppError.notFound("Audit not found");
  }

  const items = audit.items ?? [];
  const auditContext = [
    `Title: ${audit.title}`,
    `Description: ${audit.description ?? ""}`,
    `Priority: ${audit.priority}`,
    "Items:",
    ...items.map(
      i => `- ${i.label}: ${i.value || "N/A"} (Status: ${i.complianceStatus || "Pending"})`,
    ),
  ].join("\n");

  const { data } = await runTask<{
    summary?: string;
    riskScore?: number;
    insights?: unknown;
    recommendations?: unknown;
  }>(
    "report-insights",
    {
      system:
        "You are an expert audit compliance assistant. Analyze the audit data and provide a summary (string), a risk score 0-100 (number), and detailed insights/recommendations. Output valid JSON ONLY with keys: summary, riskScore, insights.",
      user: untrustedDataBlock("AUDIT CONTEXT", auditContext),
    },
    { userId: input.userId },
  );

  return Report.create({
    auditId: input.auditId,
    userId: new mongoose.Types.ObjectId(input.userId),
    summary: data.summary,
    riskScore: data.riskScore,
    generatedContent: data.insights ?? data.recommendations ?? JSON.stringify(data, null, 2),
  });
}
