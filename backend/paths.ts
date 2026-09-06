import { homedir } from "node:os";
import { join } from "node:path";

export function defaultConfigDir(): string {
  return process.env.OMARCHY_CUSTOMER_REVIEWS_CONFIG_DIR
    || join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "omarchy-customer-reviews");
}

export function defaultCacheDir(): string {
  return process.env.OMARCHY_CUSTOMER_REVIEWS_CACHE_DIR
    || join(process.env.XDG_CACHE_HOME || join(homedir(), ".cache"), "omarchy-customer-reviews");
}
