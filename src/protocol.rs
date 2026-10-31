use serde::Serialize;
use serde_json::{Map, Value};

pub const FIVE_HOUR_WINDOW_MINS: u32 = 300;
pub const WEEKLY_WINDOW_MINS: u32 = 10_080;

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageWindow {
    pub window_duration_mins: u32,
    pub used_percent: String,
    pub remaining_percent: String,
    pub resets_at: u64,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageWindows {
    pub five_hour: Option<UsageWindow>,
    pub weekly: Option<UsageWindow>,
}

impl UsageWindows {
    pub fn is_complete(&self) -> bool {
        self.five_hour.is_some() && self.weekly.is_some()
    }
}

pub fn parse_rate_limits(value: &Value) -> Option<UsageWindows> {
    let mut found_shape = false;
    let mut windows = UsageWindows::default();
    let ordinary_usage_allowed = value
        .get("ordinaryUsageAllowed")
        .or_else(|| {
            value
                .get("rateLimits")
                .and_then(|r| r.get("ordinaryUsageAllowed"))
        })
        .and_then(Value::as_bool);

    if let Some(by_id_value) = value.get("rateLimitsByLimitId") {
        found_shape = true;
        if !by_id_value.is_null() {
            let by_id = by_id_value.as_object()?;
            collect_by_id(by_id, &mut windows, ordinary_usage_allowed);
        }
    }

    if let Some(single) = value.get("rateLimits") {
        found_shape = true;
        if !single.is_null() {
            if !single.is_object() {
                return None;
            }
            if let Some(by_id_value) = single.get("rateLimitsByLimitId") {
                if !by_id_value.is_null() {
                    let by_id = by_id_value.as_object()?;
                    collect_by_id(by_id, &mut windows, ordinary_usage_allowed);
                }
            }
            if single.get("primary").is_some() || single.get("secondary").is_some() {
                collect_bucket(single, &mut windows, ordinary_usage_allowed);
            }
        }
    }

    if value.get("primary").is_some() || value.get("secondary").is_some() {
        found_shape = true;
        collect_bucket(value, &mut windows, ordinary_usage_allowed);
    }

    found_shape.then_some(windows)
}

fn collect_by_id(
    by_id: &Map<String, Value>,
    windows: &mut UsageWindows,
    ordinary_usage_allowed: Option<bool>,
) {
    for (id, bucket) in by_id {
        if id != "codex" {
            collect_bucket(bucket, windows, ordinary_usage_allowed);
        }
    }
    if let Some(codex_bucket) = by_id.get("codex") {
        collect_bucket(codex_bucket, windows, ordinary_usage_allowed);
    }
}

fn collect_bucket(
    bucket: &Value,
    windows: &mut UsageWindows,
    ordinary_usage_allowed: Option<bool>,
) {
    for key in ["primary", "secondary"] {
        let Some(window_value) = bucket.get(key).filter(|v| !v.is_null()) else {
            continue;
        };
        let Some(window) = parse_window(window_value, ordinary_usage_allowed) else {
            continue;
        };
        match window.window_duration_mins {
            FIVE_HOUR_WINDOW_MINS => windows.five_hour = Some(window),
            WEEKLY_WINDOW_MINS => windows.weekly = Some(window),
            _ => {}
        }
    }
}

fn parse_window(value: &Value, ordinary_usage_allowed: Option<bool>) -> Option<UsageWindow> {
    let object = value.as_object()?;
    let duration = object
        .get("windowDurationMins")?
        .as_u64()?
        .try_into()
        .ok()?;
    let used_number = object.get("usedPercent")?.as_number()?;
    let used_raw = used_number.to_string();
    let mut remaining = subtract_from_100(&used_raw)?;
    if remaining == "0" && ordinary_usage_allowed == Some(true) {
        remaining = "1".to_owned();
    }
    let used_float = used_number.as_f64()?;
    if !used_float.is_finite() || !(0.0..=100.0).contains(&used_float) {
        return None;
    }
    let resets_at = object.get("resetsAt")?.as_u64()?;
    if resets_at == 0 {
        return None;
    }

    Some(UsageWindow {
        window_duration_mins: duration,
        used_percent: used_raw,
        remaining_percent: remaining,
        resets_at,
    })
}

fn subtract_from_100(value: &str) -> Option<String> {
    const MAX_SCALE: usize = 28;

    if value.is_empty() || value.starts_with('-') {
        return None;
    }
    let (mantissa, exponent) =
        match value.find(|character: char| character == 'e' || character == 'E') {
            Some(index) => {
                let exponent = value[index + 1..].parse::<i32>().ok()?;
                (&value[..index], exponent)
            }
            None => (value, 0),
        };
    let mut split = mantissa.split('.');
    let whole = split.next()?;
    let fraction = split.next().unwrap_or("");
    if split.next().is_some()
        || whole.is_empty()
        || !whole.bytes().all(|b| b.is_ascii_digit())
        || !fraction.bytes().all(|b| b.is_ascii_digit())
    {
        return None;
    }

    let mut digits = format!("{whole}{fraction}");
    let mut scale = i32::try_from(fraction.len()).ok()?.checked_sub(exponent)?;
    if scale < 0 {
        let zeros = usize::try_from(-scale).ok()?;
        if zeros > MAX_SCALE || digits.len().checked_add(zeros)? > 38 {
            return None;
        }
        digits.extend(std::iter::repeat('0').take(zeros));
        scale = 0;
    }
    let scale = usize::try_from(scale).ok()?;
    if scale > MAX_SCALE || digits.len() > 38 {
        return None;
    }
    let used = digits.parse::<u128>().ok()?;
    let factor = 10u128.checked_pow(u32::try_from(scale).ok()?)?;
    let hundred = 100u128.checked_mul(factor)?;
    if used > hundred {
        return None;
    }
    let remaining = hundred - used;
    if scale == 0 {
        return Some(remaining.to_string());
    }

    let mut digits = remaining.to_string();
    if digits.len() <= scale {
        digits = format!("{}{}", "0".repeat(scale + 1 - digits.len()), digits);
    }
    let decimal_at = digits.len() - scale;
    digits.insert(decimal_at, '.');
    while digits.ends_with('0') {
        digits.pop();
    }
    if digits.ends_with('.') {
        digits.pop();
    }
    Some(digits)
}

pub fn rpc_id(message: &Value) -> Option<u64> {
    message.get("id")?.as_u64()
}

pub fn rate_limits_read_result(message: &Value) -> Option<&Map<String, Value>> {
    let result = message.get("result")?.as_object()?;
    let has_known_shape =
        result.contains_key("rateLimits") || result.contains_key("rateLimitsByLimitId");
    has_known_shape.then_some(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn finds_both_periods_across_rate_limit_buckets() {
        let payload = json!({
            "rateLimitsByLimitId": {
                "codex": { "primary": { "usedPercent": 8.125, "windowDurationMins": 300, "resetsAt": 1800000000 } },
                "codex_other": { "secondary": { "usedPercent": 27, "windowDurationMins": 10080, "resetsAt": 1800600000 } }
            }
        });
        let windows = parse_rate_limits(&payload).unwrap();
        assert_eq!(windows.five_hour.unwrap().remaining_percent, "91.875");
        assert_eq!(windows.weekly.unwrap().remaining_percent, "73");
    }

    #[test]
    fn partial_notification_only_contains_its_reported_period() {
        let payload = json!({
            "rateLimits": {
                "limitId": "codex",
                "primary": { "usedPercent": 12.5, "windowDurationMins": 300, "resetsAt": 1800000000 }
            }
        });
        let windows = parse_rate_limits(&payload).unwrap();
        assert!(!windows.is_complete());
        assert_eq!(windows.five_hour.unwrap().remaining_percent, "87.5");
        assert!(windows.weekly.is_none());
    }

    #[test]
    fn missing_window_is_not_estimated_from_another_duration() {
        let payload = json!({
            "rateLimits": {
                "primary": { "usedPercent": 10, "windowDurationMins": 60, "resetsAt": 1800000000 }
            }
        });
        let windows = parse_rate_limits(&payload).unwrap();
        assert!(windows.five_hour.is_none());
        assert!(windows.weekly.is_none());
    }

    #[test]
    fn null_period_data_is_unavailable_instead_of_invented() {
        let payload = json!({ "rateLimitsByLimitId": null });
        let windows = parse_rate_limits(&payload).unwrap();
        assert!(windows.five_hour.is_none());
        assert!(windows.weekly.is_none());
    }

    #[test]
    fn read_response_with_a_changed_schema_is_rejected() {
        let response = json!({ "id": 4, "result": { "limits": [] } });
        assert!(rate_limits_read_result(&response).is_none());
    }

    #[test]
    fn exact_decimal_subtraction_preserves_precision() {
        assert_eq!(
            subtract_from_100("8.1234567").as_deref(),
            Some("91.8765433")
        );
        assert_eq!(subtract_from_100("1e-7").as_deref(), Some("99.9999999"));
        assert_eq!(subtract_from_100("100.000").as_deref(), Some("0"));
        assert_eq!(subtract_from_100("100.01"), None);
        assert_eq!(subtract_from_100("-1"), None);
    }

    #[test]
    fn rejects_incomplete_or_invalid_window_objects() {
        let payload = json!({
            "rateLimits": {
                "primary": { "usedPercent": 102, "windowDurationMins": 300, "resetsAt": 1800000000 },
                "secondary": { "usedPercent": 20, "windowDurationMins": 10080 }
            }
        });
        let windows = parse_rate_limits(&payload).unwrap();
        assert!(windows.five_hour.is_none());
        assert!(windows.weekly.is_none());
    }

    #[test]
    fn prefers_codex_bucket_when_duplicate_durations() {
        let payload = json!({
            "rateLimitsByLimitId": {
                "codex": {
                    "primary": { "usedPercent": 10, "windowDurationMins": 300, "resetsAt": 1800000000 }
                },
                "other": {
                    "primary": { "usedPercent": 90, "windowDurationMins": 300, "resetsAt": 1800000000 }
                }
            }
        });
        let windows = parse_rate_limits(&payload).unwrap();
        assert_eq!(windows.five_hour.unwrap().used_percent, "10");
    }

    #[test]
    fn ordinary_usage_allowed_preserves_active_quota_when_used_is_100() {
        let active = json!({
            "ordinaryUsageAllowed": true,
            "rateLimits": {
                "primary": { "usedPercent": 0, "windowDurationMins": 300, "resetsAt": 1800000000 },
                "secondary": { "usedPercent": 100, "windowDurationMins": 10080, "resetsAt": 1800600000 }
            }
        });
        let windows = parse_rate_limits(&active).unwrap();
        assert_eq!(windows.five_hour.unwrap().remaining_percent, "100");
        assert_eq!(windows.weekly.unwrap().remaining_percent, "1");

        let blocked = json!({
            "ordinaryUsageAllowed": false,
            "rateLimits": {
                "secondary": { "usedPercent": 100, "windowDurationMins": 10080, "resetsAt": 1800600000 }
            }
        });
        let windows_blocked = parse_rate_limits(&blocked).unwrap();
        assert_eq!(windows_blocked.weekly.unwrap().remaining_percent, "0");
    }
}
