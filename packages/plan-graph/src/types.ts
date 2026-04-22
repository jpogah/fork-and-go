import type { PlanFrontmatter, PlanStatus } from "./schema.ts";

export type PlanLocation = "active" | "completed";

export interface Plan {
  id: string;
  title: string;
  phase: string;
  status: PlanStatus;
  dependsOn: string[];
  estimatedPasses: number;
  acceptanceTags: string[];
  location: PlanLocation;
  filePath: string;
  body: string;
  raw: PlanFrontmatter;
}

export type GraphIssue =
  | {
      kind: "duplicate-id";
      id: string;
      files: string[];
    }
  | {
      kind: "missing-dependency";
      id: string;
      missing: string;
      filePath: string;
    }
  | {
      kind: "cycle";
      path: string[];
    }
  | {
      kind: "id-filename-mismatch";
      id: string;
      filePath: string;
    }
  | {
      kind: "status-location-mismatch";
      id: string;
      status: PlanStatus;
      location: PlanLocation;
      filePath: string;
    }
  | {
      kind: "self-dependency";
      id: string;
      filePath: string;
    };

export type ValidationResult =
  | { ok: true }
  | { ok: false; issues: GraphIssue[] };

export interface PlanStatusReport {
  id: string;
  title: string;
  phase: string;
  status: PlanStatus;
  dependsOn: string[];
  blocks: string[];
  eligible: boolean;
  unmetDependencies: string[];
  location: PlanLocation;
  filePath: string;
  estimatedPasses: number;
  acceptanceTags: string[];
}
