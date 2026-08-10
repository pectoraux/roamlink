import { NextRequest } from "next/server";
import { checkDeviceCompatibility, platformGuidance } from "@/lib/esim/compatibility";
import { json, errorResponse } from "@/lib/api";

/** Check device eSIM compatibility. GET /api/compatibility?device=iphone+15 */
export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const device = searchParams.get("device");
    const platform = searchParams.get("platform") as "ios" | "android" | null;

    if (device) {
      const result = checkDeviceCompatibility(device);
      if (result) return json({ found: true, result });
      return json({ found: false, message: "Device not found in our database. Check your device settings for eSIM support." });
    }

    if (platform) {
      const guidance = platformGuidance(platform);
      return json({ found: true, result: guidance });
    }

    return json({ error: "Provide ?device= or ?platform= parameter" }, { status: 400 });
  } catch (err) {
    return errorResponse(err);
  }
}
