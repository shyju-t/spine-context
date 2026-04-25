import { z } from "zod";

/**
 * Canonical entity types — these become Kuzu node tables.
 * Facts attach to nodes via Fact.entity_id.
 */

export const PersonSchema = z.object({
  id: z.string(),                         // canonical ID, usually "person/<emp_id>"
  emp_id: z.string().optional(),
  name: z.string(),
  email: z.string().optional(),
  level: z.string().optional(),
  category: z.string().optional(),        // department
  aliases: z.array(z.string()).default([]),
});
export type Person = z.infer<typeof PersonSchema>;

export const CustomerSchema = z.object({
  id: z.string(),                         // "customer/<customer_id>"
  customer_id: z.string(),
  name: z.string(),
  aliases: z.array(z.string()).default([]),
});
export type Customer = z.infer<typeof CustomerSchema>;

export const ProductSchema = z.object({
  id: z.string(),                         // "product/<product_id>"
  product_id: z.string(),
  name: z.string(),
  category: z.string().optional(),
  aliases: z.array(z.string()).default([]),
});
export type Product = z.infer<typeof ProductSchema>;

export const ClientSchema = z.object({
  id: z.string(),                         // "client/<client_id>"
  client_id: z.string(),
  name: z.string(),
  industry: z.string().optional(),
  contact_person_name: z.string().optional(),
  aliases: z.array(z.string()).default([]),
});
export type Client = z.infer<typeof ClientSchema>;

export const VendorSchema = z.object({
  id: z.string(),                         // "vendor/<vendor_id>"
  vendor_id: z.string(),
  name: z.string(),
  industry: z.string().optional(),
  aliases: z.array(z.string()).default([]),
});
export type Vendor = z.infer<typeof VendorSchema>;

export const ProjectSchema = z.object({
  id: z.string(),                         // "project/<slug>"
  name: z.string(),
  aliases: z.array(z.string()).default([]),
});
export type Project = z.infer<typeof ProjectSchema>;

export const TopicSchema = z.object({
  id: z.string(),                         // "topic/<slug>"
  name: z.string(),
  aliases: z.array(z.string()).default([]),
});
export type Topic = z.infer<typeof TopicSchema>;

export const DecisionSchema = z.object({
  id: z.string(),                         // "decision/<slug>"
  name: z.string(),
  aliases: z.array(z.string()).default([]),
});
export type Decision = z.infer<typeof DecisionSchema>;

export const CommitmentSchema = z.object({
  id: z.string(),                         // "commitment/<slug>"
  name: z.string(),
  aliases: z.array(z.string()).default([]),
});
export type Commitment = z.infer<typeof CommitmentSchema>;

/** Discriminator for canonical entity types stored in the graph. */
export type EntityType =
  | "Person"
  | "Customer"
  | "Product"
  | "Client"
  | "Vendor"
  | "Project"
  | "Topic"
  | "Decision"
  | "Commitment";
