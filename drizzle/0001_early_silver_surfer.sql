CREATE TABLE "counterparty" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"inn" text,
	"contacts" text,
	"body_types" text,
	"directions" text,
	"vat_included" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE "driver" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"name" text NOT NULL,
	"phone" text
);
--> statement-breakpoint
CREATE TABLE "location" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"name" text NOT NULL,
	"address" text,
	"lat" double precision NOT NULL,
	"lon" double precision NOT NULL,
	"tz" text NOT NULL,
	"kind" text NOT NULL,
	"entry_lat" double precision,
	"entry_lon" double precision,
	"entry_notes" text,
	"pass_rules" text,
	"contact" text,
	"service_min" integer DEFAULT 30 NOT NULL,
	"default_window_start" text,
	"default_window_end" text,
	"external_key" text,
	CONSTRAINT "location_external_key" UNIQUE("org_id","external_key")
);
--> statement-breakpoint
CREATE TABLE "vehicle" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"plate" text NOT NULL,
	"body_type" text,
	"capacity_kg" integer,
	"capacity_pallets" integer,
	"capacity_m3" double precision,
	"max_perm_mass_t" double precision,
	"mass_t" double precision,
	"axle_load_t" double precision,
	"height_m" double precision,
	"width_m" double precision,
	"length_m" double precision,
	"pass_ids" integer[] DEFAULT '{}' NOT NULL,
	"fuel_norm_l_100km" double precision
);
--> statement-breakpoint
ALTER TABLE "counterparty" ADD CONSTRAINT "counterparty_org_id_organization_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "driver" ADD CONSTRAINT "driver_org_id_organization_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "location" ADD CONSTRAINT "location_org_id_organization_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vehicle" ADD CONSTRAINT "vehicle_org_id_organization_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;