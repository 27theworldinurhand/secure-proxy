// FxA openID configuration
const FXA_OPENID = "https://accounts.firefox.com/.well-known/openid-configuration";

// List of attributes for the openID configuration
const FXA_ENDPOINT_PROFILE = "userinfo_endpoint";
const FXA_ENDPOINT_TOKEN = "token_endpoint";
const FXA_ENDPOINT_ISSUER = "issuer";

const FETCH_TIMEOUT = 10000; // 10 secs

// Token scopes
const FXA_PROFILE_SCOPE = "profile";
const FXA_PROXY_SCOPE = "https://identity.mozilla.com/apps/secure-proxy";

// The client ID for this extension
const FXA_CLIENT_ID = "a8c528140153d1c6";

// Token expiration time
const FXA_EXP_TOKEN_TIME = 21600; // 6 hours
const FXA_EXP_WELLKNOWN_TIME = 3600; // 1 hour

// How early we want to re-generate the tokens (in secs)
const EXPIRE_DELTA = 3600;

/* eslint-disable-next-line no-unused-vars */
class FxAUtils extends Component {
  constructor(receiver) {
    super(receiver);

    this.fxaEndpoints = new Map();
    this.fxaEndpointsReceivedAt = 0;

    // This is Set of pending operatations to do after a token generation.
    this.postTokenGenerationOps = new Set();
    this.generatingTokens = false;

    this.nextExpireTime = 0;
  }

  async init(prefs) {
    this.fxaOpenID = prefs.value.fxaURL || FXA_OPENID;
    this.proxyURL = new URL(prefs.value.proxyURL || PROXY_URL);

    let fxaEndpointsReceivedAt = await StorageUtils.getFxaEndpointsReceivedAt();
    if (fxaEndpointsReceivedAt) {
      this.fxaEndpointsReceivedAt = fxaEndpointsReceivedAt;
    }

    // Let's start the fetching, but without waiting for the result.
    this.fetchWellKnownData();

    // Let's see if we have to generate new tokens, but without waiting for the
    // result.
    this.maybeGenerateTokens();
  }

  hasWellKnownData() {
    return this.fxaEndpoints.size !== 0;
  }

  async fetchWellKnownData() {
    log("Fetching well-known data");

    let now = performance.timeOrigin + performance.now();
    let nowInSecs = Math.round(now / 1000);

    if (this.hasWellKnownData() &&
        (this.fxaEndpointsReceivedAt + FXA_EXP_WELLKNOWN_TIME) > nowInSecs) {
      log("Well-knonw data cache is good");
      return true;
    }

    log("Fetching well-known data for real");

    // Let's fetch the data with a timeout of FETCH_TIMEOUT milliseconds.
    let json;
    try {
      json = await Promise.race([
        fetch(this.fxaOpenID).then(r => r.json(), e => null),
        new Promise(resolve => {
          setTimeout(_ => resolve(null), FETCH_TIMEOUT);
        }),
      ]);
    } catch (e) {
      console.error("Failed to fetch the well-known resource", e);
    }

    if (!json) {
      return false;
    }

    this.fxaEndpoints.set(FXA_ENDPOINT_PROFILE, json[FXA_ENDPOINT_PROFILE]);
    this.fxaEndpoints.set(FXA_ENDPOINT_TOKEN, json[FXA_ENDPOINT_TOKEN]);
    this.fxaEndpoints.set(FXA_ENDPOINT_ISSUER, json[FXA_ENDPOINT_ISSUER]);

    this.fxaEndpointsReceivedAt = nowInSecs;
    await StorageUtils.setFxaEndpointsReceivedAt(this.fxaEndpointsReceivedAt);

    return true;
  }

  async authenticate() {
    if (!await this.fetchWellKnownData()) {
      throw new Error("Failure fetching well-known data");
    }

    // Let's do the authentication. This will generate a token that is going to
    // be used just to obtain the other ones.
    let refreshTokenData = await this.generateRefreshToken();
    if (!refreshTokenData) {
      throw new Error("No refresh token");
    }

    // Let's store the refresh token and let's invalidate all the other tokens
    // in order to regenerate them.
    await StorageUtils.setAllTokenData(refreshTokenData, null, null, null);

    // Let's obtain the proxy token data
    if (!await this.maybeGenerateTokens()) {
      throw new Error("Token generation failed");
    }
  }

  async maybeGenerateTokens() {
    log("maybe generate tokens");

    if (this.generatingTokens) {
      log("token generation in progress. Let's wait.");
      return new Promise(resolve => { this.postTokenGenerationOps.add(resolve); });
    }

    this.generatingTokens = true;
    const result = await this.maybeGenerateTokensInternal();
    this.generatingTokens = false;

    // Let's take all the ops and execute them.
    let ops = this.postTokenGenerationOps;
    this.postTokenGenerationOps = new Set();
    ops.forEach(value => value(result));

    return result;
  }

  async maybeGenerateTokensInternal() {
    let refreshTokenData = await StorageUtils.getRefreshTokenData();
    if (!refreshTokenData) {
      return false;
    }

    let proxyTokenData = await this.maybeGenerateSingleToken("proxyTokenData",
                                                             refreshTokenData,
                                                             FXA_PROXY_SCOPE,
                                                             this.proxyURL.href);
    if (proxyTokenData === false) {
      return false;
    }

    let profileTokenData = await this.maybeGenerateSingleToken("profileTokenData",
                                                               refreshTokenData,
                                                               FXA_PROFILE_SCOPE,
                                                               this.fxaEndpoints.get(FXA_ENDPOINT_PROFILE));
    if (profileTokenData === false) {
      return false;
    }

    let profileData = await StorageUtils.getProfileData();
    // Let's obtain the profile data for the user.
    if (!profileData || profileTokenData.tokenGenerated) {
      profileData = await this.generateProfileData(profileTokenData.tokenData);
      if (!profileData) {
        return false;
      }
    }

    await StorageUtils.setDynamicTokenData(proxyTokenData.tokenData, profileTokenData.tokenData, profileData);

    // Let's pick the min time diff.
    let minDiff = Math.min(proxyTokenData.minDiff, profileTokenData.minDiff);

    // Let's schedule the token rotation.
    this.tokenGenerationTimeout = setTimeout(async _ => {
      if (!await this.maybeGenerateTokens()) {
        log("token generation failed");
        await this.sendMessage("authenticationFailed");
      }
    }, minDiff * 1000);

    this.nextExpireTime = Math.min(proxyTokenData.tokenData.received_at + proxyTokenData.tokenData.expires_in,
                                   profileTokenData.tokenData.received_at + profileTokenData.tokenData.expires_in);

    this.sendMessage("tokenGenerated", {
      tokenType: proxyTokenData.tokenData.token_type,
      tokenValue: proxyTokenData.tokenData.access_token,
    });

    return true;
  }

  async maybeGenerateSingleToken(tokenName, refreshTokenData, scope, resource) {
    log(`maybe generate token:  ${tokenName}`);

    let minDiff = 0;
    let tokenGenerated = false;

    let now = performance.timeOrigin + performance.now();
    let nowInSecs = Math.round(now / 1000);

    let tokenData = await StorageUtils.getStorageKey(tokenName);
    if (tokenData) {
      // If we are close to the expiration time, we have to generate the token.
      // We want to keep a big time margin: 1 hour seems good enough.
      let diff = tokenData.received_at + tokenData.expires_in - nowInSecs - EXPIRE_DELTA;
      if (diff < EXPIRE_DELTA) {
        log(`Token exists but it is expired. Received at ${tokenData.received_at} and expires in ${tokenData.expires_in}`);
        tokenData = null;
      } else {
        log(`token expires in ${diff}`);
        minDiff = diff;
      }
    }

    if (!tokenData) {
      log("checking well-known data");
      if (!await this.fetchWellKnownData()) {
        return false;
      }

      log("generating token");
      tokenData = await this.generateToken(refreshTokenData, scope, resource);
      if (!tokenData) {
        return false;
      }

      minDiff = tokenData.received_at + tokenData.expires_in - nowInSecs - EXPIRE_DELTA;
      log(`token expires in ${minDiff}`);
      tokenGenerated = true;
    }

    return {
      minDiff,
      tokenData,
      tokenGenerated,
    };
  }

  async generateProfileData(profileTokenData) {
    log("generate profile data");

    const headers = new Headers({
      "Authorization": `Bearer ${profileTokenData.access_token}`
    });

    const request = new Request(this.fxaEndpoints.get(FXA_ENDPOINT_PROFILE), {
      method: "GET",
      headers,
    });

    try {
      const resp = await fetch(request);
      if (resp.status !== 200) {
        log("profile data generation failed: " + resp.status);
        return null;
      }

      return resp.json();
    } catch (e) {
      console.error("Failed to fetch profile data", e);
      return null;
    }
  }

  async generateRefreshToken() {
    log("generate refresh token");

    const fxaKeysUtil = new fxaCryptoRelier.OAuthUtils({
      contentServer: this.fxaEndpoints.get(FXA_ENDPOINT_ISSUER),
    });

    let refreshTokenData;
    // This will trigger the authentication form.
    try {
      refreshTokenData = await fxaKeysUtil.launchWebExtensionFlow(FXA_CLIENT_ID, {
        redirectUri: browser.identity.getRedirectURL(),
        scopes: [FXA_PROFILE_SCOPE, FXA_PROXY_SCOPE],
      });
    } catch (e) {
      console.error("Failed to fetch the refresh token", e);
    }

    return refreshTokenData;
  }

  async generateToken(refreshTokenData, scope, resource) {
    log("generate token - scope: " + scope);

    // See https://github.com/mozilla/fxa/blob/0ed71f677637ee5f817fa17c265191e952f5500e/packages/fxa-auth-server/fxa-oauth-server/docs/pairwise-pseudonymous-identifiers.md
    const ppid_seed = Math.floor(Math.random() * 1024);

    const headers = new Headers();
    headers.append("Content-Type", "application/json");

    const request = new Request(this.fxaEndpoints.get(FXA_ENDPOINT_TOKEN), {
      method: "POST",
      headers,
      body: JSON.stringify({
        /* eslint-disable camelcase*/
        client_id: FXA_CLIENT_ID,
        grant_type: "refresh_token",
        refresh_token: refreshTokenData.refresh_token,
        scope,
        ttl: FXA_EXP_TOKEN_TIME,
        ppid_seed,
        resource,
        /* eslint-enable camelcase*/
      })
    });

    let token;
    try {
      const resp = await fetch(request);
      if (resp.status !== 200) {
        log("token generation failed: " + resp.status);
        return null;
      }

      token = await resp.json();
    } catch (e) {
      console.error("Failed to fetch the token with scope: " + scope, e);
      return null;
    }

    // Let's store when this token has been received.
    token.received_at = Math.round((performance.timeOrigin + performance.now()) / 1000);

    return token;
  }

  waitForTokenGeneration() {
    let nowInSecs = Math.round((performance.timeOrigin + performance.now()) / 1000);
    if (this.generatingTokens ||
        (this.nextExpireTime && nowInSecs >= this.nextExpireTime)) {
      log("Suspend detected!");
      return this.maybeGenerateTokens();
    }

    return null;
  }

  isAuthUrl(origin) {
    if (new URL(this.fxaOpenID).origin === origin) {
      return true;
    }

    if (!this.hasWellKnownData()) {
      return false;
    }

    // If is part of oauth also ignore
    const authUrls = [
      this.fxaEndpoints.get(FXA_ENDPOINT_PROFILE),
      this.fxaEndpoints.get(FXA_ENDPOINT_TOKEN),
    ];

    return authUrls.some((item) => {
      return new URL(item).origin === origin;
    });
  }

  excludedDomains() {
    let excludedDomains = [];

    if (this.hasWellKnownData()) {
      [FXA_ENDPOINT_PROFILE, FXA_ENDPOINT_TOKEN, FXA_ENDPOINT_ISSUER].forEach(e => {
        try {
          excludedDomains.push(new URL(this.fxaEndpoints.get(e)).hostname);
        } catch (e) {}
      });
    }

    return excludedDomains;
  }

  async manageAccountURL() {
    if (!this.hasWellKnownData()) {
      throw new Error("We are not supposed to be here.");
    }

    let contentServer = this.fxaEndpoints.get(FXA_ENDPOINT_ISSUER);
    let profileData = await StorageUtils.getProfileData();
    let url = new URL(contentServer + "/settings");
    url.searchParams.set("uid", profileData.uid);
    url.searchParams.set("email", profileData.email);
    return url.href;
  }
}