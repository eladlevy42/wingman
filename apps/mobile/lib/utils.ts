import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

// Same helper as apps/web/src/lib/utils.ts — react-native-reusables components
// import it as `~/lib/utils`, matching the alias in components.json.
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
