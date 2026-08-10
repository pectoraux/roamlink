import { NextRequest } from "next/server";
import { listPlans, getPopularDestinations, getRegions, getCountries } from "@/lib/plans/service";
import { json, errorResponse } from "@/lib/api";

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const query = {
      search: searchParams.get("search") ?? undefined,
      countryCode: searchParams.get("country") ?? undefined,
      region: searchParams.get("region") ?? undefined,
      minDataMB: searchParams.get("minData") ? Number(searchParams.get("minData")) : undefined,
      maxDataMB: searchParams.get("maxData") ? Number(searchParams.get("maxData")) : undefined,
      minValidityDays: searchParams.get("minValidity") ? Number(searchParams.get("minValidity")) : undefined,
      maxValidityDays: searchParams.get("maxValidity") ? Number(searchParams.get("maxValidity")) : undefined,
      sort: (searchParams.get("sort") as "price_asc" | "price_desc" | "data_asc" | "data_desc" | "validity_desc") ?? undefined,
    };
    const [plans, destinations, regions, countries] = await Promise.all([
      listPlans(query),
      getPopularDestinations(8),
      getRegions(),
      getCountries(),
    ]);
    return json({ plans, destinations, regions, countries });
  } catch (err) {
    return errorResponse(err);
  }
}
