use cosmos::{config::Config, init_logging, run};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let config = Config::from_env()?;
    init_logging(config.log_level);
    run(config).await?;
    Ok(())
}
