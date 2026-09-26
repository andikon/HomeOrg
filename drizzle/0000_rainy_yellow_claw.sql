CREATE TABLE "households" (
	"singleton" boolean PRIMARY KEY DEFAULT true NOT NULL,
	"id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "households_id_unique" UNIQUE("id"),
	CONSTRAINT "households_singleton_true" CHECK ("households"."singleton" IS TRUE)
);
