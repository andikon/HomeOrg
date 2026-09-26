CREATE TABLE "board_posts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"household_id" uuid NOT NULL,
	"author_member_id" uuid NOT NULL,
	"message" text NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone,
	CONSTRAINT "board_posts_revision_positive" CHECK ("board_posts"."revision" > 0)
);
--> statement-breakpoint
CREATE TABLE "entries" (
	"id" uuid PRIMARY KEY NOT NULL,
	"list_id" uuid NOT NULL,
	"title" text NOT NULL,
	"quantity" text,
	"unit" text,
	"note" text,
	"due_date" date,
	"completed" boolean DEFAULT false NOT NULL,
	"position" integer NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "entries_position_nonnegative" CHECK ("entries"."position" >= 0),
	CONSTRAINT "entries_revision_positive" CHECK ("entries"."revision" > 0),
	CONSTRAINT "entries_quantity_positive_decimal" CHECK ("entries"."quantity" IS NULL OR ("entries"."quantity" ~ '^(0|[1-9][0-9]*)(\.[0-9]{1,3})?$' AND "entries"."quantity"::numeric > 0))
);
--> statement-breakpoint
CREATE TABLE "lists" (
	"id" uuid PRIMARY KEY NOT NULL,
	"household_id" uuid NOT NULL,
	"name" text NOT NULL,
	"position" integer NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"entries_revision" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "lists_position_nonnegative" CHECK ("lists"."position" >= 0),
	CONSTRAINT "lists_revision_positive" CHECK ("lists"."revision" > 0),
	CONSTRAINT "lists_entries_revision_positive" CHECK ("lists"."entries_revision" > 0)
);
--> statement-breakpoint
ALTER TABLE "households" ADD COLUMN "lists_revision" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "board_posts" ADD CONSTRAINT "board_posts_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "board_posts" ADD CONSTRAINT "board_posts_author_member_id_members_id_fk" FOREIGN KEY ("author_member_id") REFERENCES "public"."members"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entries" ADD CONSTRAINT "entries_list_id_lists_id_fk" FOREIGN KEY ("list_id") REFERENCES "public"."lists"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lists" ADD CONSTRAINT "lists_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "board_posts_household_created_id_idx" ON "board_posts" USING btree ("household_id","created_at","id");--> statement-breakpoint
CREATE INDEX "entries_list_position_idx" ON "entries" USING btree ("list_id","position","id");--> statement-breakpoint
CREATE INDEX "lists_household_position_idx" ON "lists" USING btree ("household_id","position","id");--> statement-breakpoint
ALTER TABLE "households" ADD CONSTRAINT "households_lists_revision_positive" CHECK ("households"."lists_revision" > 0);