import { connectHost, isHosted, reportHostError } from "./bridge";
import { loadingOpening } from "../loading-opening";

try {
  await connectHost();
  loadingOpening.setStatus("正在读取音乐库…");
  await import("../music-app");
  if (isHosted) await import("./workspace");
} catch (error) {
  loadingOpening.fail(error);
  reportHostError(error);
}
