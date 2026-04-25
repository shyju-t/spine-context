/**
 * Kuzu schema definitions. Run as DDL on a fresh database.
 * Idempotent: graph.init() catches "already exists" errors.
 *
 * Storage choices:
 *  - Dates stored as ISO STRING (Kuzu's TIMESTAMP support varies by version;
 *    string is the safe lowest-common-denominator).
 *  - JSON metadata stored as STRING; deserialize on read.
 *  - source_span stored as two INT64 columns (Kuzu doesn't have tuple/struct).
 *  - Arrays (acl, aliases) stored as JSON-encoded STRING — Kuzu 0.6.x's
 *    prepared-statement param binding does not accept JS arrays, so we
 *    serialize on write and parse on read. Query like:
 *      WHERE n.acl CONTAINS '"role:hr"'
 */

export const ALL_DDL: string[] = [
  // ───── Source: raw records ingested from any system ─────
  `CREATE NODE TABLE Source(
     id STRING,
     type STRING,
     external_id STRING,
     subject STRING,
     content STRING,
     metadata STRING,
     ingested_at STRING,
     acl STRING,
     PRIMARY KEY(id)
   )`,

  // ───── Fact: an assertion about an entity, with provenance ─────
  `CREATE NODE TABLE Fact(
     id STRING,
     entity_id STRING,
     attribute STRING,
     value STRING,
     type STRING,
     valid_from STRING,
     valid_to STRING,
     tx_from STRING,
     tx_to STRING,
     source_id STRING,
     source_span_start INT64,
     source_span_end INT64,
     confidence DOUBLE,
     author STRING,
     acl STRING,
     override_by STRING,
     override_reason STRING,
     PRIMARY KEY(id)
   )`,

  // ───── Person: employee canonical entity ─────
  `CREATE NODE TABLE Person(
     id STRING,
     emp_id STRING,
     name STRING,
     email STRING,
     level STRING,
     category STRING,
     aliases STRING,
     PRIMARY KEY(id)
   )`,

  // ───── Customer ─────
  `CREATE NODE TABLE Customer(
     id STRING,
     customer_id STRING,
     name STRING,
     aliases STRING,
     PRIMARY KEY(id)
   )`,

  // ───── Product ─────
  `CREATE NODE TABLE Product(
     id STRING,
     product_id STRING,
     name STRING,
     category STRING,
     aliases STRING,
     PRIMARY KEY(id)
   )`,

  // ───── Client (B2B engagements from Business_and_Management/clients.json) ─────
  `CREATE NODE TABLE Client(
     id STRING,
     client_id STRING,
     name STRING,
     industry STRING,
     contact_person_name STRING,
     aliases STRING,
     PRIMARY KEY(id)
   )`,

  // ───── Vendor (from Business_and_Management/vendors.json) ─────
  `CREATE NODE TABLE Vendor(
     id STRING,
     vendor_id STRING,
     name STRING,
     industry STRING,
     aliases STRING,
     PRIMARY KEY(id)
   )`,

  // ───── Project (declared; populated by LLM extractor as projects emerge) ─────
  `CREATE NODE TABLE Project(
     id STRING,
     name STRING,
     aliases STRING,
     PRIMARY KEY(id)
   )`,

  // ───── Topic (open-ended, LLM-proposed) ─────
  `CREATE NODE TABLE Topic(
     id STRING,
     name STRING,
     aliases STRING,
     PRIMARY KEY(id)
   )`,

  // ───── Decision (LLM-proposed) ─────
  `CREATE NODE TABLE Decision(
     id STRING,
     name STRING,
     aliases STRING,
     PRIMARY KEY(id)
   )`,

  // ───── Commitment (LLM-proposed) ─────
  `CREATE NODE TABLE Commitment(
     id STRING,
     name STRING,
     aliases STRING,
     PRIMARY KEY(id)
   )`,

  // ───── Relationships ─────
  `CREATE REL TABLE Manages(FROM Person TO Person)`,

  // Mentions edges: Source -[:MentionsPerson]-> Person, etc.
  // Kuzu requires per-target-table rel tables; one Mentions per entity type.
  `CREATE REL TABLE MentionsPerson(FROM Source TO Person, role STRING, confidence DOUBLE)`,
  `CREATE REL TABLE MentionsCustomer(FROM Source TO Customer, role STRING, confidence DOUBLE)`,
  `CREATE REL TABLE MentionsProduct(FROM Source TO Product, role STRING, confidence DOUBLE)`,
  `CREATE REL TABLE MentionsClient(FROM Source TO Client, role STRING, confidence DOUBLE)`,
  `CREATE REL TABLE MentionsVendor(FROM Source TO Vendor, role STRING, confidence DOUBLE)`,
  `CREATE REL TABLE MentionsProject(FROM Source TO Project, role STRING, confidence DOUBLE)`,
  `CREATE REL TABLE MentionsTopic(FROM Source TO Topic, role STRING, confidence DOUBLE)`,
  `CREATE REL TABLE MentionsDecision(FROM Source TO Decision, role STRING, confidence DOUBLE)`,
  `CREATE REL TABLE MentionsCommitment(FROM Source TO Commitment, role STRING, confidence DOUBLE)`,
];
