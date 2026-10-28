import { expect, it } from "vitest";
import { makeZip } from "../src/lib/audio";

it("explains ZIP32's limit before trying to allocate a multi-gigabyte archive", async () => {
  // Only metadata is needed to reject an archive that ZIP32 cannot represent.
  const blob = { size: 0x100000000 } as Blob;
  await expect(
    makeZip([{ name: "large.wav", blob }], new AbortController().signal),
  ).rejects.toThrow("4 GB format limit");
});
