plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "app.tether"
    compileSdk = 35 // bump to 37 once the Android 17 SDK is installed (SPEC targets API 37)

    defaultConfig {
        applicationId = "app.tether"
        minSdk = 29
        targetSdk = 35 // -> 37; see docs/SPEC.md §2 (A17 behavior + AAPM)
        versionCode = 1
        versionName = "0.0.1"
    }

    sourceSets["main"].java.srcDirs("src/main/kotlin")

    buildTypes {
        release {
            isMinifyEnabled = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
}

dependencies {
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.appcompat:appcompat:1.7.0")

    // Signaling transport to apps/server.
    implementation("com.squareup.okhttp3:okhttp:4.12.0")

    // QR pairing (SPEC §4).
    implementation("com.google.zxing:core:3.5.3")
    implementation("androidx.camera:camera-camera2:1.3.4")
    implementation("androidx.camera:camera-lifecycle:1.3.4")

    // Media transport + audio (SPEC §4): libwebrtc. Pick a maintained prebuilt,
    // e.g. io.github.webrtc-sdk:android, and wire an external HW video encoder.
    // implementation("io.github.webrtc-sdk:android:<pinned>")

    // Noise_IK session (SPEC §4): a Noise library or BouncyCastle primitives.
    // implementation("...noise...")
}
