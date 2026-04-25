import type { EntityType } from "@spine/schema";

export type ResolveMethod =
  | "id"               // emp_0431, B0B82YGCF6, CLNT-0001 — confidence 1.0
  | "email"            // raj.patel@inazuma.com — confidence 1.0
  | "full_name"        // "Raj Patel" — confidence 0.95
  | "first_initial"    // "R. Patel" — confidence 0.7
  | "last_name"        // "Patel" alone — confidence 0.3
  | "first_name"       // "Raj" alone — confidence 0.2 (multiple candidates likely)
  | "alias"            // declared alias on the entity — confidence 0.9
  | "context";         // "I"/"me"/"you" resolved via sender/recipient — confidence 0.95

export interface Mention {
  span: [number, number];          // char offsets in the source text
  surface: string;                 // the matched substring
  entity_id: string;               // canonical entity ID, e.g. "person/emp_0431"
  entity_type: EntityType;
  confidence: number;              // 0..1
  method: ResolveMethod;
  candidates?: string[];           // other entity_ids if the match was ambiguous
}

export interface ResolverContext {
  source_type?: string;
  sender_emp_id?: string;          // for "I"/"me"/"my" resolution
  recipient_emp_id?: string;       // for "you"/"your"/"Hi <name>" resolution
  date?: Date;                     // for temporal disambiguation
}

export interface SurfaceForm {
  text: string;                    // e.g. "Raj Patel", "emp_0431"
  text_lower: string;              // pre-lowercased for case-insensitive match
  method: ResolveMethod;
  base_confidence: number;
}

export interface CanonicalEntity {
  id: string;                      // "person/emp_0431"
  type: EntityType;
  display_name: string;            // for debugging / UI
  surface_forms: SurfaceForm[];
}

export interface ResolverStats {
  total_entities: number;
  total_surface_forms: number;
  by_type: Record<EntityType, number>;
}
