plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.samredwings.multihf"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.samredwings.multihf"
        minSdk = 24
        targetSdk = 35
        versionCode = 2
        versionName = "0.1.1"
    }

    buildTypes {
        debug { applicationIdSuffix = ".debug" }
        release {
            isMinifyEnabled = false
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
    implementation("androidx.activity:activity:1.10.1")
    implementation("androidx.webkit:webkit:1.12.1")
}
