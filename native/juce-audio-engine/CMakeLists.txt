cmake_minimum_required(VERSION 3.22)

set(CMAKE_MSVC_RUNTIME_LIBRARY "MultiThreaded$<$<CONFIG:Debug>:Debug>")
project(juce_audio_engine VERSION 0.1.0 LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

include(FetchContent)
FetchContent_Declare(
  JUCE
  GIT_REPOSITORY https://github.com/juce-framework/JUCE.git
  GIT_TAG 8.0.0
)
FetchContent_MakeAvailable(JUCE)

juce_add_console_app(juce-audio-engine
  PRODUCT_NAME "juce-audio-engine"
)

target_sources(juce-audio-engine
  PRIVATE
    src/Main.cpp
)

target_compile_definitions(juce-audio-engine
  PRIVATE
    JUCE_WEB_BROWSER=0
    JUCE_USE_CURL=0
    JUCE_ASIO=1
)

target_include_directories(juce-audio-engine
  PRIVATE
    ${CMAKE_CURRENT_LIST_DIR}/../../third_party/asio-sdk/common
)

if(MSVC)
  target_compile_options(juce-audio-engine PRIVATE /EHsc)
endif()

target_link_libraries(juce-audio-engine
  PRIVATE
    juce::juce_audio_devices
    juce::juce_audio_formats
    juce::juce_audio_utils
    juce::juce_core
)

if(WIN32)
  target_link_libraries(juce-audio-engine PRIVATE winmm)
endif()
