import { z } from "zod";
import { zMediaCatalogResult } from "./mediaCatalog";

export const LOCAL_CATALOG_MODEL = "Qwen/Qwen3.5-9B";
export const LOCAL_CATALOG_REVISION =
  "c202236235762e1c871ad0ccb60c8ee5ba337b9a";
// Bump whenever prompt, sampling, quantization or validation changes.
export const LOCAL_CATALOG_RECIPE = "qwen35-nf4-catalog-v1";

export const zLocalCatalogResponse = z
  .object({
    model: z.literal(LOCAL_CATALOG_MODEL),
    revision: z.literal(LOCAL_CATALOG_REVISION),
    recipe: z.literal(LOCAL_CATALOG_RECIPE),
    result: zMediaCatalogResult,
  })
  .strict();
