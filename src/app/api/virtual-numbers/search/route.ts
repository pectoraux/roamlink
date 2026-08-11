import { NextRequest } from "next/server";
import { searchNumbers, getNumberCountries } from "@/lib/virtual-numbers/service";
import { json, errorResponse } from "@/lib/api";

/** GET /api/virtual-numbers/search — search available numbers or get country catalog. */
export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const countryCode = searchParams.get("country") ?? undefined;
    const region = searchParams.get("region") ?? undefined;
    const smsRequired = searchParams.get("sms") === "true";
    const voiceRequired = searchParams.get("voice") === "true";
    const mmsRequired = searchParams.get("mms") === "true";

    // If no filter params, return the country catalog
    if (!countryCode && !region && !smsRequired && !voiceRequired && !mmsRequired) {
      const countries = await getNumberCountries();
      return json({ countries });
    }

    const numbers = await searchNumbers({ countryCode, region, smsRequired, voiceRequired, mmsRequired });
    return json({ numbers });
  } catch (err) {
    return errorResponse(err);
  }
}
