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
        // The kit's nebula texture and monochrome menu-bar template ship in the
        // SwiftPM resource bundle; the CLI copies that bundle into Cosmos.app.
        .target(name: "CosmosMac", resources: [.process("Resources")]),
        .systemLibrary(name: "CCosmosSurface"),
        .executableTarget(name: "CosmosDesktop", dependencies: ["CosmosMac", "CCosmosSurface"]),
        .testTarget(name: "CosmosMacTests", dependencies: ["CosmosMac"]),
    ]
)
