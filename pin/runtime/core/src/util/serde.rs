use serde::Serializer;

pub fn f64_serialize_1_decimal<S>(value: &f64, serializer: S) -> Result<S::Ok, S::Error>
where
    S: Serializer,
{
    serializer.serialize_f64((value * 10.).round() / 10.)
}

pub fn f64_option_serialize_1_decimal<S>(
    value: &Option<f64>,
    serializer: S,
) -> Result<S::Ok, S::Error>
where
    S: Serializer,
{
    match value {
        Some(v) => f64_serialize_1_decimal(v, serializer),
        None => serializer.serialize_none(),
    }
}
