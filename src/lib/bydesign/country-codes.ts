/**
 * ISO country code -> the country NAME ByDesign expects.
 *
 * Port of ByDesignPaymentService::COUNTRY_CODE_MAP, which app/services/by_design.rb
 * also reads. Kept in its own module so both call sites share one table, as
 * they did in Ruby.
 *
 * Two ByDesign quirks recorded in the Ruby comments and preserved here: China
 * is displayed as "Hong Kong Cross Market" but must be SENT as "CHINA", and
 * Korea needs the full "KOREA (THE REPUBLIC OF)".
 */
export const COUNTRY_CODE_MAP: Record<string, string> = {
  US: "USA",
  CA: "CANADA",
  GB: "UNITED KINGDOM",
  UK: "UNITED KINGDOM",
  AU: "AUSTRALIA",
  NZ: "NEW ZEALAND",
  MX: "MEXICO",
  HK: "HONG KONG",
  TW: "TAIWAN",
  SG: "SINGAPORE",
  MY: "MALAYSIA",
  JP: "JAPAN",
  TH: "THAILAND",
  KR: "KOREA (THE REPUBLIC OF)",
  CN: "CHINA",
  DE: "GERMANY",
  NL: "NETHERLANDS",
  BE: "BELGIUM",
};
