import { z } from "zod";
import type {
  Client,
  Customer,
  Product,
  Vendor,
} from "@spine/schema";
import { safeReadFile } from "./safe-fs.js";

/**
 * Registry loaders for canonical entities that aren't really "sources" of
 * extracted facts — they're authoritative catalogs. Customers, products,
 * clients, vendors. Each row is a structured entity row, not a document
 * to extract from.
 *
 * No SourceRecord per row, no LLM. Just bulk-load into the graph as nodes
 * so the resolver can use them and the LLM extractor can resolve mentions
 * against them.
 *
 * If we want provenance later (e.g. "this customer was loaded from
 * customers.json on 2026-04-25"), we'd add a single Source per registry
 * file. Out of scope for now.
 */

// ───────── Customers ─────────

const RawCustomerSchema = z
  .object({
    customer_id: z.string(),
    customer_name: z.string(),
  })
  .passthrough();

export async function loadCustomers(path: string): Promise<Customer[]> {
  const text = await safeReadFile(path);
  const data = JSON.parse(text);
  if (!Array.isArray(data)) throw new Error(`[customers] expected array`);

  const out: Customer[] = [];
  let skipped = 0;
  for (const raw of data) {
    const parsed = RawCustomerSchema.safeParse(raw);
    if (!parsed.success) {
      skipped += 1;
      continue;
    }
    const r = parsed.data;
    out.push({
      id: `customer/${r.customer_id}`,
      customer_id: r.customer_id,
      name: r.customer_name,
      aliases: [],
    });
  }
  if (skipped) console.warn(`[customers] skipped ${skipped} malformed`);
  return out;
}

// ───────── Products ─────────

const RawProductSchema = z
  .object({
    product_id: z.string(),
    product_name: z.string(),
    category: z.string().optional(),
  })
  .passthrough();

export async function loadProducts(path: string): Promise<Product[]> {
  const text = await safeReadFile(path);
  const data = JSON.parse(text);
  if (!Array.isArray(data)) throw new Error(`[products] expected array`);

  const out: Product[] = [];
  let skipped = 0;
  for (const raw of data) {
    const parsed = RawProductSchema.safeParse(raw);
    if (!parsed.success) {
      skipped += 1;
      continue;
    }
    const r = parsed.data;
    out.push({
      id: `product/${r.product_id}`,
      product_id: r.product_id,
      name: r.product_name,
      category: r.category,
      aliases: [],
    });
  }
  if (skipped) console.warn(`[products] skipped ${skipped} malformed`);
  return out;
}

// ───────── Clients (Business_and_Management/clients.json) ─────────

const RawClientSchema = z
  .object({
    client_id: z.string(),
    business_name: z.string(),
    industry: z.string().optional(),
    contact_person_name: z.string().optional(),
  })
  .passthrough();

export async function loadClients(path: string): Promise<Client[]> {
  const text = await safeReadFile(path);
  const data = JSON.parse(text);
  if (!Array.isArray(data)) throw new Error(`[clients] expected array`);

  const out: Client[] = [];
  let skipped = 0;
  for (const raw of data) {
    const parsed = RawClientSchema.safeParse(raw);
    if (!parsed.success) {
      skipped += 1;
      continue;
    }
    const r = parsed.data;
    out.push({
      id: `client/${r.client_id}`,
      client_id: r.client_id,
      name: r.business_name,
      industry: r.industry,
      contact_person_name: r.contact_person_name,
      aliases: [],
    });
  }
  if (skipped) console.warn(`[clients] skipped ${skipped} malformed`);
  return out;
}

// ───────── Vendors (Business_and_Management/vendors.json) ─────────
//
// Vendors confusingly use `client_id` as their primary key in the source
// data. We map it to vendor_id internally so the schema stays clean.

const RawVendorSchema = z
  .object({
    client_id: z.string(),
    business_name: z.string(),
    industry: z.string().optional(),
  })
  .passthrough();

export async function loadVendors(path: string): Promise<Vendor[]> {
  const text = await safeReadFile(path);
  const data = JSON.parse(text);
  if (!Array.isArray(data)) throw new Error(`[vendors] expected array`);

  const out: Vendor[] = [];
  let skipped = 0;
  for (const raw of data) {
    const parsed = RawVendorSchema.safeParse(raw);
    if (!parsed.success) {
      skipped += 1;
      continue;
    }
    const r = parsed.data;
    out.push({
      id: `vendor/${r.client_id}`,
      vendor_id: r.client_id,
      name: r.business_name,
      industry: r.industry,
      aliases: [],
    });
  }
  if (skipped) console.warn(`[vendors] skipped ${skipped} malformed`);
  return out;
}
