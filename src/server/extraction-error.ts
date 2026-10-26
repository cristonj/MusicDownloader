import { HttpError } from "./security";

export class ExtractionError extends HttpError {
  constructor(
    public readonly category: string,
    message: string,
    public readonly retryable: boolean,
    status = 502,
  ) {
    super(status, message);
  }
}

// Raw diagnostics can contain signed media URLs. Classify them privately rather
// than returning subprocess output or labeling every failure as a private track.
export function extractionFailure(
  stderr: string,
  youtube: boolean,
): ExtractionError {
  const source = youtube ? "YouTube" : "The source";
  if (/private video|video is private|this video is private/i.test(stderr))
    return new ExtractionError(
      "PRIVATE_TRACK",
      "This track is private.",
      false,
      422,
    );
  if (
    /video (?:has been |was )?removed|has been deleted|no longer available|account.*terminated|video does not exist/i.test(
      stderr,
    )
  )
    return new ExtractionError(
      "REMOVED_TRACK",
      "This track has been removed from the source.",
      false,
      422,
    );
  if (/DRM protected/i.test(stderr))
    return new ExtractionError(
      "DRM_PROTECTED",
      "This track is DRM-protected at the source and can’t be downloaded.",
      false,
      422,
    );
  if (
    /not available in your country|not available from your location|geo.?restrict|blocked.*country/i.test(
      stderr,
    )
  )
    return new ExtractionError(
      "REGION_RESTRICTED",
      "This track is unavailable in the web server’s region.",
      false,
      422,
    );
  if (
    /confirm.{0,30}not a bot|bot.?check|automated (?:queries|requests)|too many requests|HTTP Error 429/i.test(
      stderr,
    )
  )
    return new ExtractionError(
      "SOURCE_BLOCKED_SERVER",
      `${source} is blocking requests from this web server. Try again later.`,
      true,
      503,
    );
  if (
    /sign in to confirm your age|age.?restrict|login required|members.only|join this channel|premium.only|requires? authentication/i.test(
      stderr,
    )
  )
    return new ExtractionError(
      "LOGIN_REQUIRED",
      "This track requires a signed-in account at the source.",
      false,
      422,
    );
  if (
    /failed to (?:load|extract).*python|error while loading shared libraries|GLIBC_|GLIBCXX_|PyInstaller|read-only file system|no space left|permission denied|no such option|usage: yt-dlp/i.test(
      stderr,
    )
  )
    return new ExtractionError(
      "EXTRACTOR_RUNTIME",
      "The download engine could not run on the web server.",
      false,
      503,
    );
  if (
    /certificate verify failed|CERTIFICATE_VERIFY_FAILED|unable to get local issuer/i.test(
      stderr,
    )
  )
    return new ExtractionError(
      "SOURCE_TLS",
      "The web server could not establish a secure connection to the source.",
      false,
      503,
    );
  if (
    /requested format.*not available|no video formats|no formats found|only images are available|signature (?:extraction|solving)|challenge (?:extraction|solving)|n challenge|failed to extract.*(?:signature|player)/i.test(
      stderr,
    )
  )
    return new ExtractionError(
      "AUDIO_FORMAT_UNAVAILABLE",
      "No usable audio stream was returned by the source.",
      true,
      422,
    );
  if (
    /HTTP Error (?:403|502|503|504)|timed? out|connection (?:reset|refused)|unable to download|page needs to be reloaded|video unavailable|sign in/i.test(
      stderr,
    )
  )
    return new ExtractionError(
      "SOURCE_REQUEST_FAILED",
      `${source} could not open this recording. Please try again.`,
      true,
      503,
    );
  return new ExtractionError(
    "EXTRACTION_FAILED",
    "The source could not provide a downloadable recording. Please try again.",
    true,
  );
}
