Checkpoint 55 fixes a missing semicolon after `const prevPepper = process.env.AFFILIATE_AUTH_PEPPER`
in the affiliate production-cookie Jest test. The following parenthesized assignment was parsed as a call to the pepper string, leading to TypeError.
This does not change production authentication or secrets.
Full Jest verification must be rerun against the verified isolated local PostgreSQL on port 5433.
