import * as z from "zod/mini";

const token = z.string().check(z.minLength(1));
const timestamp = z.iso.datetime({ offset: true });
const millis = z.int().check(z.nonnegative(), z.maximum(8_640_000_000_000_000));
export const youtubeCredentialsSchema = z.object({
  access_token: token,
  expiry_date: timestamp,
  refresh_token: token,
  scope: z.optional(z.string()),
  token_type: z.optional(z.string()),
  client: z.optional(z.object({ client_id: token, client_secret: token })),
});
export type YoutubeOAuthCredentials = z.infer<typeof youtubeCredentialsSchema>;
const tidalCredentialsSchema = z.object({
  access_token: token,
  refresh_token: z.optional(token),
  expires_at: millis,
  user_id: z.optional(token),
  country_code: z.optional(z.string().check(z.regex(/^[A-Za-z]{2}$/u))),
  scope: z.optional(z.string()),
  token_type: z.optional(z.string()),
});
export type TidalCredentials = z.infer<typeof tidalCredentialsSchema>;
const musicAccountRecordSchema = z.object({
  youtube_music: z.optional(
    z.object({
      credentials: youtubeCredentialsSchema,
      connected_at: timestamp,
    }),
  ),
  apple_music: z.optional(
    z.object({
      music_user_token: token,
      storefront: z.optional(z.string()),
      connected_at: timestamp,
    }),
  ),
  tidal: z.optional(
    z.object({
      credentials: z.optional(tidalCredentialsSchema),
      connected_at: z.optional(timestamp),
      pending: z.optional(
        z.object({
          state: token,
          verifier: token,
          redirect_uri: z.url(),
          expires_at: millis,
        }),
      ),
    }),
  ),
});
export type MusicAccountRecord = z.infer<typeof musicAccountRecordSchema>;
export const revisionedMusicAccountsSchema = z.object({
  revision: z.int().check(z.nonnegative()),
  accounts: musicAccountRecordSchema,
});
