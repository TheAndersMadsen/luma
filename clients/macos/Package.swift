// swift-tools-version: 5.10
import PackageDescription

let package = Package(
    name: "CosmosMac",
    platforms: [.macOS(.v14)],
    products: [
        .library(name: "CosmosMac", targets: ["CosmosMac"]),
        .executable(name: "CosmosDesktop", targets: ["CosmosDesktop"]),
    ],
    targets: [
        .target(name: "CosmosMac"),
        .systemLibrary(name: "CCosmosSurface"),
        .executableTarget(name: "CosmosDesktop", dependencies: ["CosmosMac", "CCosmosSurface"]),
        .testTarget(name: "CosmosMacTests", dependencies: ["CosmosMac"]),
    ]
)
