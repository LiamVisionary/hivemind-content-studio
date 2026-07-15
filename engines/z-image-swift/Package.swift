// swift-tools-version: 6.0
import PackageDescription

let package = Package(
  name: "zimage.swift",
  platforms: [.macOS(.v14), .iOS(.v17)],
  products: [
    .library(name: "ZImage", targets: ["ZImage"]),
    .executable(name: "ZImageCLI", targets: ["ZImageCLI"]),
    .executable(name: "ZImageServe", targets: ["ZImageServe"]),
  ],
  dependencies: [
    .package(url: "https://github.com/ml-explore/mlx-swift", .upToNextMinor(from: "0.30.6")),
    .package(url: "https://github.com/huggingface/swift-huggingface.git", from: "0.7.0"),
    .package(
      url: "https://github.com/huggingface/swift-transformers",
      .upToNextMinor(from: "1.1.9")
    ),
    .package(url: "https://github.com/apple/swift-log.git", from: "1.6.4"),
  ],
  targets: [
    .target(
      name: "ZImage",
      dependencies: [
        .product(name: "MLX", package: "mlx-swift"),
        .product(name: "MLXFast", package: "mlx-swift"),
        .product(name: "MLXNN", package: "mlx-swift"),
        .product(name: "MLXOptimizers", package: "mlx-swift"),
        .product(name: "MLXRandom", package: "mlx-swift"),
        .product(name: "HuggingFace", package: "swift-huggingface"),
        .product(name: "Hub", package: "swift-transformers"),
        .product(name: "Tokenizers", package: "swift-transformers"),
        .product(name: "Logging", package: "swift-log"),
      ],
      path: "Sources/ZImage"
    ),
    .executableTarget(
      name: "ZImageCLI",
      dependencies: [ "SwiftPMSandboxTestingBootstrap", /* swiftpm-sandbox-testing */ "ZImageCLICommon" ],
      path: "Sources/ZImageCLI"
    ),
    .target(
      name: "ZImageCLICommon",
      dependencies: ["ZImage"],
      path: "Sources/ZImageCLICommon"
    ),
    .target(
      name: "ZImageServeCore",
      dependencies: ["ZImage", "ZImageCLICommon"],
      path: "Sources/ZImageServeCore"
    ),
    .executableTarget(
      name: "ZImageServe",
      dependencies: [ "SwiftPMSandboxTestingBootstrap", /* swiftpm-sandbox-testing */ "ZImageCLICommon", "ZImageServeCore" ],
      path: "Sources/ZImageServe"
    ),
    .testTarget(
      name: "ZImageTests",
      dependencies: [
          "SwiftPMSandboxTestingBootstrap", // swiftpm-sandbox-testing
        "ZImage",
        "ZImageCLICommon",
        "ZImageServeCore",
        .product(name: "MLX", package: "mlx-swift"),
      ],
      path: "Tests/ZImageTests",
      exclude: ["Fixtures/Snapshots"]
    ),
    .testTarget(
      name: "ZImageIntegrationTests",
      dependencies: [
          "SwiftPMSandboxTestingBootstrap", // swiftpm-sandbox-testing
        "ZImage",
        .product(name: "MLX", package: "mlx-swift"),
      ],
      path: "Tests/ZImageIntegrationTests"
    ),
    .testTarget(
      name: "ZImageE2ETests",
      dependencies: [ "SwiftPMSandboxTestingBootstrap", /* swiftpm-sandbox-testing */ "ZImage" ],
      path: "Tests/ZImageE2ETests"
    ),
        // swiftpm-sandbox-testing: begin
        .target(
            name: "SwiftPMSandboxTestingBootstrap",
            path: "Sources/SwiftPMSandboxTestingBootstrap",
            publicHeadersPath: "include"
        ),
        // swiftpm-sandbox-testing: end
  ]
)
