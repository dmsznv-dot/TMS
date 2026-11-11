CREATE TABLE "trip_cargo" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"trip_id" uuid NOT NULL,
	"stop_id" uuid NOT NULL,
	"order_line_id" uuid NOT NULL,
	"qty_milli" bigint NOT NULL,
	"loaded_milli" bigint,
	CONSTRAINT "trip_cargo_line_stop" UNIQUE("stop_id","order_line_id")
);
--> statement-breakpoint
CREATE TABLE "trip_stop" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"trip_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"location_id" uuid NOT NULL,
	"operation" text NOT NULL,
	"actual_arrive_at" timestamp with time zone,
	"actual_depart_at" timestamp with time zone,
	"skipped_reason" text
);
--> statement-breakpoint
CREATE TABLE "trip" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"number" text NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"cancel_reason" text,
	"baseline_plan_version_id" uuid,
	"mileage_km" double precision,
	"mileage_unknown" boolean DEFAULT false NOT NULL,
	"close_override_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone,
	CONSTRAINT "trip_number_key" UNIQUE("org_id","number")
);
--> statement-breakpoint
ALTER TABLE "trip_cargo" ADD CONSTRAINT "trip_cargo_org_id_organization_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trip_cargo" ADD CONSTRAINT "trip_cargo_trip_id_trip_id_fk" FOREIGN KEY ("trip_id") REFERENCES "public"."trip"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trip_cargo" ADD CONSTRAINT "trip_cargo_stop_id_trip_stop_id_fk" FOREIGN KEY ("stop_id") REFERENCES "public"."trip_stop"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trip_cargo" ADD CONSTRAINT "trip_cargo_order_line_id_order_line_id_fk" FOREIGN KEY ("order_line_id") REFERENCES "public"."order_line"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trip_stop" ADD CONSTRAINT "trip_stop_org_id_organization_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trip_stop" ADD CONSTRAINT "trip_stop_trip_id_trip_id_fk" FOREIGN KEY ("trip_id") REFERENCES "public"."trip"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trip_stop" ADD CONSTRAINT "trip_stop_location_id_location_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."location"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trip" ADD CONSTRAINT "trip_org_id_organization_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "trip_cargo_line_idx" ON "trip_cargo" USING btree ("order_line_id");--> statement-breakpoint
CREATE INDEX "trip_cargo_trip_idx" ON "trip_cargo" USING btree ("trip_id");--> statement-breakpoint
CREATE INDEX "trip_stop_trip_idx" ON "trip_stop" USING btree ("trip_id","seq");--> statement-breakpoint
CREATE INDEX "trip_status_idx" ON "trip" USING btree ("org_id","status");