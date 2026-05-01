import { FEATURE_DEFAULTS } from "../../../storage/feature-store";
import { BODHI_FEATURES_LIST_METHOD, type BodhiFeaturesListResponse } from "../../../wire";
import type { ExtMethodHost } from "../types";

export async function featuresList(params: unknown, host: ExtMethodHost): Promise<BodhiFeaturesListResponse> {
	const sessionId = (params as { sessionId?: unknown }).sessionId;
	if (typeof sessionId !== "string") {
		throw new Error(`${BODHI_FEATURES_LIST_METHOD}: params.sessionId is required`);
	}
	const features = await host.readFeatures(sessionId);
	return {
		features: { ...features },
		defaults: { ...FEATURE_DEFAULTS },
	};
}
