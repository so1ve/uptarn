use anyhow::{Context, Result, bail};

fn read_tlv(input: &[u8]) -> Result<(u8, &[u8], &[u8])> {
    let (&tag, rest) = input.split_first().context("unexpected EOF in DER tag")?;
    let (&len_byte, mut rest) = rest.split_first().context("unexpected EOF in DER length")?;
    let len = if len_byte & 0x80 == 0 {
        usize::from(len_byte)
    } else {
        let count = usize::from(len_byte & 0x7f);
        if count == 0 || count > 4 {
            bail!("unsupported DER length encoding");
        }
        let (len_bytes, tail) = rest
            .split_at_checked(count)
            .context("truncated DER length")?;
        let mut parsed = 0usize;
        for &b in len_bytes {
            parsed = (parsed << 8) | usize::from(b);
        }
        rest = tail;
        parsed
    };
    let (value, tail) = rest.split_at_checked(len).context("truncated DER value")?;

    Ok((tag, value, tail))
}

fn expect_tag(input: &[u8], expected: u8) -> Result<(&[u8], &[u8])> {
    let (tag, value, rest) = read_tlv(input)?;
    if tag != expected {
        bail!("unexpected DER tag 0x{tag:02x}, expected 0x{expected:02x}");
    }

    Ok((value, rest))
}

fn parse_digits(s: &str) -> Result<i64> {
    if !s.bytes().all(|b| b.is_ascii_digit()) {
        bail!("non-digit in X.509 time field '{s}'");
    }

    s.parse().context("invalid X.509 time integer")
}

const fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let y = year - if month <= 2 { 1 } else { 0 };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let doy = (153 * (month + if month > 2 { -3 } else { 9 }) + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;

    era * 146_097 + doe - 719_468
}

fn parse_x509_time(tag: u8, bytes: &[u8]) -> Result<i64> {
    let text = std::str::from_utf8(bytes).context("non-UTF8 X.509 time")?;
    let body = text
        .strip_suffix('Z')
        .context("X.509 time must use UTC 'Z' suffix")?;
    let (year, rest) = match tag {
        0x17 => {
            if body.len() != 12 {
                bail!("invalid UTCTime '{text}'");
            }
            let yy = parse_digits(&body[0..2])?;
            let year = if yy >= 50 { 1900 + yy } else { 2000 + yy };
            (year, &body[2..])
        }
        0x18 => {
            if body.len() != 14 {
                bail!("invalid GeneralizedTime '{text}'");
            }
            (parse_digits(&body[0..4])?, &body[4..])
        }
        _ => bail!("unexpected X.509 time tag 0x{tag:02x}"),
    };

    let month = parse_digits(&rest[0..2])?;
    let day = parse_digits(&rest[2..4])?;
    let hour = parse_digits(&rest[4..6])?;
    let minute = parse_digits(&rest[6..8])?;
    let second = parse_digits(&rest[8..10])?;
    if !(1..=12).contains(&month)
        || !(1..=31).contains(&day)
        || hour > 23
        || minute > 59
        || second > 60
    {
        bail!("out-of-range X.509 time '{text}'");
    }

    Ok(days_from_civil(year, month, day) * 86_400 + hour * 3600 + minute * 60 + second)
}

pub fn parse_not_after_unix(der: &[u8]) -> Result<i64> {
    let (cert_body, _) = expect_tag(der, 0x30)?;
    let (tbs, _) = expect_tag(cert_body, 0x30)?;
    let (first_tag, _, after_first) = read_tlv(tbs)?;
    let rest = match first_tag {
        0xa0 => expect_tag(after_first, 0x02)?.1,
        0x02 => after_first,
        _ => bail!("unexpected TBSCertificate tag 0x{first_tag:02x}"),
    };
    let (_, rest) = expect_tag(rest, 0x30)?;
    let (_, rest) = expect_tag(rest, 0x30)?;
    let (validity, _) = expect_tag(rest, 0x30)?;
    let (nb_tag, _, rest) = read_tlv(validity)?;
    if nb_tag != 0x17 && nb_tag != 0x18 {
        bail!("unexpected notBefore tag 0x{nb_tag:02x}");
    }
    let (na_tag, na_bytes, _) = read_tlv(rest)?;

    parse_x509_time(na_tag, na_bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn der_tlv(tag: u8, body: &[u8]) -> Vec<u8> {
        let mut out = vec![tag];
        if body.len() < 0x80 {
            out.push(body.len() as u8);
        } else {
            let bytes = (body.len() as u32).to_be_bytes();
            let start = bytes.iter().position(|&b| b != 0).unwrap();
            out.push(0x80 | (bytes.len() - start) as u8);
            out.extend_from_slice(&bytes[start..]);
        }
        out.extend_from_slice(body);
        out
    }

    fn build_fake_cert(v3: bool, nb_tag: u8, nb: &[u8], na_tag: u8, na: &[u8]) -> Vec<u8> {
        let mut tbs = Vec::new();
        if v3 {
            tbs.extend(der_tlv(0xa0, &der_tlv(0x02, &[2])));
        }
        tbs.extend(der_tlv(0x02, &[1]));
        tbs.extend(der_tlv(0x30, &[]));
        tbs.extend(der_tlv(0x30, &[]));
        let mut validity = Vec::new();
        validity.extend(der_tlv(nb_tag, nb));
        validity.extend(der_tlv(na_tag, na));
        tbs.extend(der_tlv(0x30, &validity));
        der_tlv(0x30, &der_tlv(0x30, &tbs))
    }

    #[test]
    fn parses_v3_utctime_and_v1_generalized_time_certificates() {
        // 2028-02-29T23:59:59Z (leap year)
        let v3 = build_fake_cert(true, 0x17, b"260101000000Z", 0x17, b"280229235959Z");
        assert_eq!(parse_not_after_unix(&v3).unwrap(), 1_835_481_599);

        // 2055-06-15T12:30:00Z (GeneralizedTime on v1 cert without [0] version)
        let v1 = build_fake_cert(false, 0x17, b"250101000000Z", 0x18, b"20550615123000Z");
        assert_eq!(parse_not_after_unix(&v1).unwrap(), 2_696_675_400);

        // Truncated DER is rejected cleanly
        assert!(parse_not_after_unix(&v3[..v3.len() - 4]).is_err());
    }
}
